<template>
  <div>
    <h1>Stream Test</h1>
    <div class="options">
      <select v-model="selectedVideoDevice" placeholder="Select video device">
        <option v-for="device in videoDevices" :value="device">
          {{ device.label }}
        </option>
      </select>
      <select v-model="selectedAudioDevice" placeholder="Select audio device">
        <option v-for="device in audioDevices" :value="device">
          {{ device.label }}
        </option>
      </select>
    </div>
    <button @click="initiateConnection">Initiate Connection</button>
    <video autoplay playsinline ref="videoEl"></video>
    <audio autoplay playsinline ref="audioEl"></audio>
  </div>
</template>

<script setup lang="ts">
import * as mediasoup from "mediasoup-client";
import { Socket, io } from "socket.io-client";
import { createRoom, joinRoom, subscribeSocketToRooms } from "~/utils";

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

const videoDevices = ref(null as MediaDeviceInfo[] | null);
const audioDevices = ref(null as MediaDeviceInfo[] | null);

const selectedVideoDevice = ref(null as MediaDeviceInfo | null);
const selectedAudioDevice = ref(null as MediaDeviceInfo | null);

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

if (import.meta.client) {
  socket = io("/", {
    path: "/api/ws/socket.io",
  });

  socket.on("connect", async () => {
    console.log("Connected to server");

    subscribeSocketToRooms(socket!, (rooms) => {
      console.log("Rooms updated", rooms);
    });

    await createRoom({ name: "room-1", socket: socket! });
  });

  const devices = await navigator.mediaDevices.enumerateDevices();
  videoDevices.value = devices.filter((device) => device.kind === "videoinput");
  audioDevices.value = devices.filter((device) => device.kind === "audioinput");
}

const initiateConnection = async () => {
  const client = await joinRoom({ room: "room-1", socket: socket! });

  const userMedia = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: selectedVideoDevice.value?.deviceId,
    },
    audio: {
      deviceId: selectedAudioDevice.value?.deviceId,
    },
  });

  // const displayMedia = await navigator.mediaDevices.getDisplayMedia({
  //   video: true,
  //   audio: true,
  // });

  const videoProducer = await client.createProducer({
    track: userMedia.getVideoTracks()[0]!,
  });

  const audioProducer = await client.createProducer({
    track: userMedia.getAudioTracks()[0]!,
  });

  const videoConsumer = await client.createConsumer({
    producerId: videoProducer.id,
    producerKind: "video",
  });

  const stream = new MediaStream();
  videoConsumer.track.addEventListener("ended", () => {
    stream.removeTrack(videoConsumer.track);
    console.log("Track ended");
  });
  stream.addTrack(videoConsumer.track);
  videoEl.value!.srcObject = stream;
  document.body.addEventListener("click", () => {
    videoEl.value!.play();
  });

  const audioConsumer = await client.createConsumer({
    producerId: audioProducer.id,
    producerKind: "audio",
  });

  const audioStream = new MediaStream();
  audioConsumer.track.addEventListener("ended", () => {
    audioStream.removeTrack(audioConsumer.track);
    console.log("Track ended");
  });
  audioStream.addTrack(audioConsumer.track);
  audioEl.value!.srcObject = audioStream;
  document.body.addEventListener("click", () => {
    audioEl.value!.play();
  });
};
</script>
