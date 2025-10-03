import type { TypedSocket } from "./types";
import * as mediasoup from "mediasoup-client";

let rooms = new Map<
  string,
  {
    rtpCapabilities: mediasoup.types.RtpCapabilities;
    members: Map<
      string,
      {
        producerIds: string[];
        consumerIds: string[];
      }
    >;
  }
>();

export function subscribeSocketToRooms(
  socket: TypedSocket,
  onRoomsUpdate: (
    rooms: Map<
      string,
      {
        rtpCapabilities: mediasoup.types.RtpCapabilities;
        members: Map<string, { producerIds: string[]; consumerIds: string[] }>;
      }
    >
  ) => void
) {
  socket.on("rooms-updated", (data) => {
    rooms = data.result!;
  });
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
  if (!rooms.has(payload.room)) {
    throw new Error("Room does not exist");
  }

  const room = rooms.get(payload.room)!;

  const device = await mediasoup.Device.factory();
  await device.load({
    routerRtpCapabilities: room.rtpCapabilities,
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
    });
  }
}
