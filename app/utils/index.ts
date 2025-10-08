import type { TypedSocket } from "./types";
import * as mediasoup from "mediasoup-client";

let _rooms = {} as {
  [key: string]: {
    rtpCapabilities: mediasoup.types.RtpCapabilities;
    members: {
      [key: string]: {
        audioProducerIds: string[];
        videoProducerIds: string[];
        consumerIds: string[];
      };
    };
  };
};

const roomsUpdateListeners = [] as ((rooms: typeof _rooms) => void)[];

export function subscribeSocketToRooms(
  socket: TypedSocket,
  onUpdate?: (rooms: typeof _rooms) => void,
  onFirstUpdate?: (rooms: typeof _rooms) => void
) {
  let fired = false;
  socket.on("rooms-updated", (data) => {
    console.log("Rooms updated", data.result!);
    _rooms = data.result!;
    onUpdate?.(_rooms);

    for (const listener of roomsUpdateListeners) {
      listener(_rooms);
    }

    if (!fired) {
      fired = true;
      onFirstUpdate?.(_rooms);
    }
  });
  return _rooms;
}

export async function createRoom(payload: {
  name: string;
  socket: TypedSocket;
}) {
  const res = await payload.socket.emitWithAck("create-room", {
    room: payload.name,
  });

  if (res.error) {
    throw new Error(res.error.type);
  }
}

export async function joinRoom(payload: { room: string; socket: TypedSocket }) {
  if (!_rooms[payload.room]) {
    throw new Error("Room does not exist");
  }

  const room = _rooms[payload.room]!;

  const device = await mediasoup.Device.factory();
  await device.load({
    routerRtpCapabilities: toRaw(room.rtpCapabilities),
  });

  if (device.rtpCapabilities.codecs?.length === 0) {
    throw new Error("No codecs supported");
  }

  return new RoomClient(device, payload.room, payload.socket);
}

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

    const producer = await this.sendTransport.produce({ track: payload.track });

    return producer;
  }

  async createConsumer(payload: {
    producerId: string;
    producerKind: "audio" | "video";
  }) {
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

        resolve(consumer);
      }
    });
  }

  async createConsumerStream(payload: {
    producerId: string;
    producerKind: "audio" | "video";
  }) {
    const consumer = await this.createConsumer(payload);
    const stream = new MediaStream();
    stream.addTrack(consumer.track);

    roomsUpdateListeners.push((rooms) => {
      if (
        payload.producerKind === "audio" &&
        !rooms[this.room]?.members[this.socket.id!]?.audioProducerIds.includes(
          payload.producerId
        )
      ) {
        stream.removeTrack(consumer.track);
        consumer.close();
        this.socket.emit(
          "close-consumer",
          {
            consumerId: consumer.id,
          },
          () => {}
        );
      } else if (
        payload.producerKind === "video" &&
        !rooms[this.room]?.members[this.socket.id!]?.videoProducerIds.includes(
          payload.producerId
        )
      ) {
        stream.removeTrack(consumer.track);
        consumer.close();
        this.socket.emit(
          "close-consumer",
          {
            consumerId: consumer.id,
          },
          () => {}
        );
      }
    });

    return stream;
  }

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

  async stopRecording(payload: { recordingId: string }) {
    await this.socket.emitWithAck("stop-recording", {
      recordingId: payload.recordingId,
    });
  }

  async close() {
    await this.sendTransport?.close();
    await this.recvTransport?.close();
    this.socket.emitWithAck("close-transport", {
      transportId: this.sendTransport!.id,
    });
    this.socket.emitWithAck("close-transport", {
      transportId: this.recvTransport!.id,
    });
  }
}
