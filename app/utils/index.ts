import type { TypedSocket } from "./types";
import * as mediasoup from "mediasoup-client";

// TODO: Update
const rooms = new Map<
  string,
  {
    rtpCapabilities: mediasoup.types.RtpCapabilities;
    members: { id: string; isProducer: boolean }[];
  }
>();

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

  rooms.set(payload.name, {
    rtpCapabilities: res.result!.rtpCapabilities,
    members: [],
  });
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

  async createProducer(payload: { track: MediaStreamTrack }) {
    const creds = await this.socket.emitWithAck("join-room", {
      room: this.room,
    });

    if (creds.error) {
      throw new Error(creds.error.type);
    }

    const sendTransport = this.device.createSendTransport({
      id: creds.result!.id,
      iceParameters: creds.result!.iceParameters,
      iceCandidates: creds.result!.iceCandidates,
      dtlsParameters: creds.result!.dtlsParameters,
    });

    sendTransport.on("connect", async ({ dtlsParameters }, callback) => {
      const res = await this.socket.emitWithAck("connect-transport", {
        transportId: sendTransport.id,
        dtlsParameters,
      });

      if (res.error) {
        throw new Error(res.error.type);
      }

      callback();
    });

    sendTransport.on("produce", async ({ kind, rtpParameters }, callback) => {
      const res = await this.socket.emitWithAck("transport-produce", {
        transportId: sendTransport.id,
        kind,
        rtpParameters,
      });

      if (res.error) {
        throw new Error(res.error.type);
      }

      callback({ id: res.result!.id });
    });

    const producer = await sendTransport.produce({ track: payload.track });

    return producer;
  }

  async createConsumer(payload: {
    producerId: string;
    producerKind: "audio" | "video";
    onConnected?: (consumer: mediasoup.types.Consumer) => void;
  }) {
    const creds = await this.socket.emitWithAck("join-room", {
      room: this.room,
    });

    if (creds.error) {
      throw new Error(creds.error.type);
    }

    let consumer: mediasoup.types.Consumer;

    const recvTransport = this.device.createRecvTransport({
      id: creds.result!.id,
      iceParameters: creds.result!.iceParameters,
      iceCandidates: creds.result!.iceCandidates,
      dtlsParameters: creds.result!.dtlsParameters,
    });

    recvTransport.on("connect", async ({ dtlsParameters }, callback) => {
      const res = await this.socket.emitWithAck("connect-transport", {
        transportId: recvTransport.id,
        dtlsParameters,
      });

      if (res.error) {
        throw new Error(res.error.type);
      }

      callback();
    });

    recvTransport.on("connectionstatechange", async (connectionState) => {
      if (connectionState === "connected") {
        const res = await this.socket.emitWithAck("resume-consume", {
          transportId: recvTransport.id,
        });

        if (res.error) {
          throw new Error(res.error.type);
        }

        console.log(connectionState);
        payload.onConnected?.(consumer);
      }
    });

    const consumeCredsRes = await this.socket.emitWithAck("transport-consume", {
      transportId: recvTransport.id,
      producerId: payload.producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });

    if (consumeCredsRes.error) {
      throw new Error(consumeCredsRes.error.type);
    }

    consumer = await recvTransport.consume({
      id: consumeCredsRes.result!.id,
      producerId: payload.producerId,
      kind: payload.producerKind,
      rtpParameters: consumeCredsRes.result!.rtpParameters,
    });

    return consumer;
  }
}
