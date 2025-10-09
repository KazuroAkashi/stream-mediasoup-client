import type { TypedSocket } from "./types";
import * as mediasoup from "mediasoup-client";

let _rooms = {} as {
  [roomName: string]: {
    rtpCapabilities: mediasoup.types.RtpCapabilities;
    members: {
      [socketId: string]: {
        audioProducerIds: string[];
        videoProducerIds: string[];
        consumerIds: string[];
      };
    };
  };
};

const consumerRoomsUpdateListeners = {} as {
  [consumerId: string]: (rooms: typeof _rooms) => void;
};

/**
 * Subscribes to the room updates. Calls `onUpdate` with the new rooms object when the rooms are updated.
 *
 * - The keys are room names.
 * - The `members` object's keys are socket ids.
 * - You should not need `rtpCapabilities` manually.
 *
 * **You must call this function before doing anything. You cannot join rooms without it.**
 *
 * @param socket The socket.io client
 * @param onUpdate *(Optional)* Called when the rooms are updated
 * @param onFirstUpdate *(Optional)* Called when the rooms are first updated (May be used for initial rendering etc.)
 */
export function subscribeSocketToRooms(
  socket: TypedSocket,
  onUpdate?: (rooms: typeof _rooms) => void,
  onFirstUpdate?: (rooms: typeof _rooms) => void
) {
  let fired = false;
  socket.on("rooms-updated", (data) => {
    _rooms = data.result!;
    onUpdate?.(_rooms);

    for (const listener of Object.values(consumerRoomsUpdateListeners)) {
      listener(_rooms);
    }

    if (!fired) {
      fired = true;
      onFirstUpdate?.(_rooms);
    }
  });
}

/**
 * Creates a room or throws an error.
 *
 * @param roomName The name of the room (Must be unique)
 * @param socket The socket.io client
 * @throws RoomAlreadyExists
 */
export async function createRoom(payload: {
  roomName: string;
  socket: TypedSocket;
}) {
  const res = await payload.socket.emitWithAck("create-room", {
    room: payload.roomName,
  });

  if (res.error) {
    throw new Error(res.error.type);
  }
}

/**
 *
 * @param roomName The name of the room
 * @param socket The socket.io client
 * @returns A RoomClient instance which can be used to create consumers and producers in the room.
 * @throws "No codecs supported"
 */
export async function joinRoom(payload: {
  roomName: string;
  socket: TypedSocket;
}) {
  if (!_rooms[payload.roomName]) {
    throw new Error("Room does not exist");
  }

  const room = _rooms[payload.roomName]!;

  const device = await mediasoup.Device.factory();
  await device.load({
    routerRtpCapabilities: toRaw(room.rtpCapabilities),
  });

  if (device.rtpCapabilities.codecs?.length === 0) {
    throw new Error("No codecs supported");
  }

  return new RoomClient(device, payload.roomName, payload.socket);
}

/**
 * A manager class which handles transports and producers/consumers.
 *
 * **This class must not be instantiated manually. Use the ``joinRoom`` function instead.**
 */
export class RoomClient {
  constructor(
    private readonly device: mediasoup.Device,
    private readonly room: string,
    private readonly socket: TypedSocket
  ) {}

  private sendTransport: mediasoup.types.Transport | null = null;
  private recvTransport: mediasoup.types.Transport | null = null;

  get roomName() {
    return this.room;
  }

  /**
   * Creates a producer which sends a video/audio track. The producer will be connected and ready after await.
   *
   * The track can be obtained from ``navigator.mediaDevices.getUserMedia()`` or ``navigator.mediaDevices.getDisplayMedia()``
   * each of which shoud have ``getVideoTracks()`` and ``getAudioTracks()`` methods.
   *
   * **Each producer can only send a single track. You must create a new producer for each track you want to send.**
   *
   * @note `navigator.mediaDevices` may not be available when running on http.
   *
   * @param track The `MediaStreamTrack` instance to send
   * @returns A mediasoup `Producer` object which can be used to pause and resume sending (No other functionality of Producer should be used manually)
   */
  async createProducer(payload: { track: MediaStreamTrack }) {
    if (this.sendTransport === null) {
      const creds = await this.socket.emitWithAck("join-room", {
        room: this.room,
      });

      if (creds.error) {
        throw new Error(creds.error.type);
      }

      console.log(creds.result);

      this.sendTransport = this.device.createSendTransport({
        id: creds.result!.id,
        iceParameters: creds.result!.iceParameters,
        iceCandidates: creds.result!.iceCandidates,
        dtlsParameters: creds.result!.dtlsParameters,
      });

      this.sendTransport.on("connect", async ({ dtlsParameters }, callback) => {
        const res = await this.socket.emitWithAck("connect-transport", {
          transportId: this.sendTransport!.id,
          dtlsParameters,
        });

        if (res.error) {
          throw new Error(res.error.type);
        }

        callback();
      });

      this.sendTransport.on(
        "produce",
        async ({ kind, rtpParameters }, callback) => {
          const res = await this.socket.emitWithAck("transport-produce", {
            transportId: this.sendTransport!.id,
            kind,
            rtpParameters,
          });

          if (res.error) {
            throw new Error(res.error.type);
          }

          callback({ id: res.result!.id });
        }
      );
    }

    const producer = await this.sendTransport.produce({
      track: payload.track,
    });

    return producer;
  }

  /**
   * **If you want to play the consumed track on an html element, it is recommended to use `createConsumerStreamElement()` instead.**
   *
   * Creates a consumer which receives a video/audio track. The consumer will be connected and ready after await.
   *
   * **The consumer will be closed automatically when the corresponding producer closes.**
   *
   * The producerId can be obtained from the rooms object (refer to ``subscribeSocketToRooms()``) or the producer object returned from ``createProducer()``.
   *
   * **Each consumer can only consume a single producer. You must create a new consumer for each producer you want to consume.**
   *
   * @note Browsers may not allow autoplay of video/audio tracks without user gesture. Consider adding a button to play the track on the UI.
   *
   * @param producerId The id of the producer to consume
   * @param producerKind The kind of the producer to consume ("audio" or "video")
   * @param onEnd Callback to be called when the consumer ends (e.g. when the corresponding producer closes)
   * @returns A mediasoup `Consumer` object which can be used to pause and resume receiving. It also provides `track` which
   * can be used in `MediaStream` to play the track, but using ``createConsumerStreamElement()`` is recommended.
   * (No other functionality of Consumer should be used manually)
   */
  async createConsumer(
    payload: {
      producerId: string;
      producerKind: "audio" | "video";
    },
    onEnd?: () => void
  ) {
    return new Promise<mediasoup.types.Consumer>(async (resolve, reject) => {
      let consumer: mediasoup.types.Consumer;
      if (this.recvTransport === null) {
        const creds = await this.socket.emitWithAck("join-room", {
          room: this.room,
        });

        if (creds.error) {
          reject(creds.error.type);
        }

        this.recvTransport = this.device.createRecvTransport({
          id: creds.result!.id,
          iceParameters: creds.result!.iceParameters,
          iceCandidates: creds.result!.iceCandidates,
          dtlsParameters: creds.result!.dtlsParameters,
        });

        this.recvTransport.on(
          "connect",
          async ({ dtlsParameters }, callback) => {
            const res = await this.socket.emitWithAck("connect-transport", {
              transportId: this.recvTransport!.id,
              dtlsParameters,
            });

            if (res.error) {
              throw new Error(res.error.type);
            }

            callback();
          }
        );

        this.recvTransport.on(
          "connectionstatechange",
          async (connectionState) => {
            if (connectionState === "connected") {
              const res = await this.socket.emitWithAck("resume-consume", {
                transportId: this.recvTransport!.id,
                consumerId: consumer!.id,
              });

              if (res.error) {
                throw new Error(res.error.type);
              }

              console.log(connectionState);
              resolve(consumer);
            }
          }
        );
      }

      const consumeCredsRes = await this.socket.emitWithAck(
        "transport-consume",
        {
          transportId: this.recvTransport.id,
          producerId: payload.producerId,
          rtpCapabilities: this.device.rtpCapabilities,
        }
      );

      if (consumeCredsRes.error) {
        throw new Error(consumeCredsRes.error.type);
      }

      consumer = await this.recvTransport.consume({
        id: consumeCredsRes.result!.id,
        producerId: payload.producerId,
        kind: payload.producerKind,
        rtpParameters: consumeCredsRes.result!.rtpParameters,
      });

      if (this.recvTransport.connectionState === "connected") {
        const res = await this.socket.emitWithAck("resume-consume", {
          transportId: this.recvTransport!.id,
          consumerId: consumer!.id,
        });

        if (res.error) {
          throw new Error(res.error.type);
        }
        consumerRoomsUpdateListeners[consumer.id] = (rooms: typeof _rooms) => {
          console.log(consumer.id, Object.values(rooms[this.room]!.members));
          if (
            payload.producerKind === "audio" &&
            !Object.values(rooms[this.room]!.members).some((member) =>
              member.audioProducerIds.includes(payload.producerId)
            )
          ) {
            consumer.close();
            this.socket.emit(
              "close-consumer",
              {
                transportId: this.recvTransport!.id,
                consumerId: consumer.id,
              },
              () => {}
            );
            delete consumerRoomsUpdateListeners[consumer.id];
            onEnd?.();
          } else if (
            payload.producerKind === "video" &&
            !Object.values(rooms[this.room]!.members).some((member) =>
              member.videoProducerIds.includes(payload.producerId)
            )
          ) {
            console.log("Video producer closed");
            consumer.close();
            this.socket.emit(
              "close-consumer",
              {
                transportId: this.recvTransport!.id,
                consumerId: consumer.id,
              },
              () => {}
            );
            delete consumerRoomsUpdateListeners[consumer.id];
            console.log("deleted callback");
            onEnd?.();
          }
        };

        resolve(consumer);
      }
    });
  }

  /**
   * **If you want to play the stream on an html element, it is recommended to use `createConsumerStreamElement()` instead.**
   *
   * Creates a consumer which receives a video/audio track. The consumer will be connected and ready after await.
   *
   * **The consumer will be closed and the track will be removed from the stream automatically when the corresponding producer closes.**
   *
   * The producerId can be obtained from the rooms object (refer to ``subscribeSocketToRooms()``) or the producer object returned from ``createProducer()``.
   *
   * **Each consumer can only consume a single producer. You must create a new consumer for each producer you want to consume.**
   *
   * @note Browsers may not allow autoplay of video/audio tracks without user gesture. Consider adding a button to play the track on the UI.
   *
   * @param producerId The id of the producer to consume
   * @param producerKind The kind of the producer to consume ("audio" or "video")
   * @param onEnd Callback to be called when the consumer ends (e.g. when the corresponding producer closes)
   * @returns A `MediaStream` object containing the received track. The function handles removing the track from the stream when the consumer ends.
   * If you want to play the stream on an html element, it is recommended to use `createConsumerStreamElement()` instead.
   */
  async createConsumerStream(
    payload: {
      producerId: string;
      producerKind: "audio" | "video";
    },
    onEnd?: () => void
  ) {
    const stream = new MediaStream();
    const consumer = await this.createConsumer(payload, () => {
      stream.removeTrack(consumer.track);
      onEnd?.();
    });
    stream.addTrack(consumer.track);

    return stream;
  }

  /**
   * Creates a consumer which receives a video/audio track. The consumer will be connected and ready after await.
   *
   * **The consumer will be closed and the stream will be removed from the element automatically when the corresponding producer closes.**
   *
   * The producerId can be obtained from the rooms object (refer to ``subscribeSocketToRooms()``) or the producer object returned from ``createProducer()``.
   *
   * **Each consumer can only consume a single producer. You must create a new consumer for each producer you want to consume.**
   *
   * @note Browsers may not allow autoplay of video/audio tracks without user gesture. Consider adding a button to play the track on the UI.
   *
   * @param producerId The id of the producer to consume
   * @param producerKind The kind of the producer to consume ("audio" or "video")
   * @param element The element to play the stream on (Be careful to use the correct type, e.g. HTMLVideoElement for video and HTMLAudioElement for audio)
   * @param onEnd Callback to be called when the consumer ends (e.g. when the corresponding producer closes)
   * @returns A `MediaStream` object containing the received track. The function handles removing the track from the stream when the consumer ends.
   * If you want to play the stream on an html element, it is recommended to use `createConsumerStreamElement()` instead.
   */
  async createConsumerStreamElement(
    payload: {
      producerId: string;
      producerKind: "audio" | "video";
      element: HTMLVideoElement | HTMLAudioElement;
    },
    onEnd?: () => void
  ) {
    const stream = await this.createConsumerStream(payload, () => {
      payload.element.srcObject = null;
      onEnd?.();
    });
    payload.element.srcObject = stream;
  }

  /**
   * Starts a recording of the given video and audio producers. The generated .m3u8 file will be available at `http://<server>/hls/<recordingId>/recording.m3u8`.
   *
   * @param recordingId The *unique* id of the recording to start
   * @param videoProducerId The id of the video producer to record **(Must be a video producer you created with ``createProducer()`` on this `RoomClient` object)**
   * @param audioProducerId The id of the audio producer to record **(Must be an audio producer you created with ``createProducer()`` on this `RoomClient` object)**
   */
  async startRecording(payload: {
    recordingId: string;
    videoProducerId: string;
    audioProducerId: string;
  }) {
    await this.socket.emitWithAck("start-recording", {
      recordingId: payload.recordingId,
      transportId: this.sendTransport!.id,
      videoProducerId: payload.videoProducerId,
      audioProducerId: payload.audioProducerId,
    });
  }

  /**
   * Stops the given recording.
   *
   * @param recordingId The id of the recording to stop
   */
  async stopRecording(payload: { recordingId: string }) {
    await this.socket.emitWithAck("stop-recording", {
      recordingId: payload.recordingId,
    });
  }

  /**
   * Closes all transports associated with this `RoomClient` object. This will also close all producers and consumers
   * associated with this `RoomClient` object. **It is strongly recommended to call this function when leaving the room.**
   */
  async close() {
    if (this.sendTransport) {
      await this.sendTransport.close();
      this.socket.emitWithAck("close-transport", {
        transportId: this.sendTransport.id,
      });
    }
    if (this.recvTransport) {
      await this.recvTransport.close();
      this.socket.emitWithAck("close-transport", {
        transportId: this.recvTransport.id,
      });
    }
  }
}
