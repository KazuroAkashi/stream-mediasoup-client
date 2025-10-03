<template>
  <div>
    <h1>Hello, World</h1>
    <button @click="initiateConnection">Initiate Connection</button>
    <video autoplay playsinline ref="videoEl"></video>
    <audio autoplay playsinline ref="audioEl"></audio>
  </div>
</template>

<script setup lang="ts">
import * as mediasoup from "mediasoup-client";
import { Socket, io } from "socket.io-client";
import { createRoom, joinRoom } from "~/utils";

interface ServerToClientEvents {}

interface ClientToServerEvents {
  "create-room": (
    payload: { room: string },
    callback?: (data: {
      rtpCapabilities: mediasoup.types.RtpCapabilities;
    }) => void
  ) => void;
  "join-room": (
    payload: { room: string },
    callback: (data: {
      id: string;
      iceParameters: mediasoup.types.IceParameters;
      iceCandidates: mediasoup.types.IceCandidate[];
      dtlsParameters: mediasoup.types.DtlsParameters;
    }) => void
  ) => void;
  "connect-transport": (
    payload: {
      transportId: string;
      dtlsParameters: mediasoup.types.DtlsParameters;
    },
    callback?: () => void
  ) => void;
  "transport-produce": (
    payload: {
      transportId: string;
      kind: "audio" | "video";
      rtpParameters: mediasoup.types.RtpParameters;
    },
    callback: (data: { id: string }) => void
  ) => void;
  "transport-consume": (
    payload: {
      transportId: string;
      producerId: string;
      rtpCapabilities: mediasoup.types.RtpCapabilities;
    },
    callback: (
      data: {
        id: string;
        rtpParameters: mediasoup.types.RtpParameters;
      } | null
    ) => void
  ) => void;
  "resume-consume": (
    payload: { transportId: string },
    callback?: () => void
  ) => void;
}

const videoEl = useTemplateRef("videoEl");
const audioEl = useTemplateRef("audioEl");
let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

if (import.meta.client) {
  socket = io("/", {
    path: "/api/ws/socket.io",
  });

  socket.on("connect", async () => {
    console.log("Connected to server");

    await createRoom({ name: "room-1", socket: socket! });
  });
}

const initiateConnection = async () => {
  const client = await joinRoom({ room: "room-1", socket: socket! });

  const userMedia = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });

  const displayMedia = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  const producer = await client.createProducer({
    track: displayMedia.getVideoTracks()[0]!,
  });

  const consumer = await client.createConsumer({
    producerId: producer.id,
    producerKind: "video",
    onConnected: (consumer) => {
      console.log("Consumer connected");
      const stream = new MediaStream();
      consumer.track.addEventListener("ended", () => {
        stream.removeTrack(consumer.track);
        console.log("Track ended");
      });
      stream.addTrack(consumer.track);
      videoEl.value!.srcObject = stream;
      document.body.addEventListener("click", () => {
        videoEl.value!.play();
      });
    },
  });
};
</script>
