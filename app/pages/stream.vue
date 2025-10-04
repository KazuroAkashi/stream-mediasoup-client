<template>
  <div :key="rerenderKey">
    <h1 v-if="currentRoomName">Room: {{ currentRoomName }}</h1>
    <h1 v-else>Start a stream</h1>

    <div class="start-stream" v-if="!currentRoomName">
      <input type="text" v-model="roomName" @input="roomError = ''" />
      <button @click="createStream">Create Stream</button>
    </div>

    <button v-if="currentRoomName" @click="leaveTheRoom">Leave Room</button>
    <div
      v-if="isStreamer"
      class="streamer-options"
      style="display: flex; gap: 10px"
    >
      <button
        v-if="userVideoProducer"
        @click="
          userVideoProducer?.paused
            ? userVideoProducer.resume()
            : userVideoProducer?.pause()
        "
      >
        Turn Camera {{ userVideoProducer?.paused ? "On" : "Off" }}
      </button>
      <button
        v-if="userAudioProducer"
        @click="
          userAudioProducer?.paused
            ? userAudioProducer.resume()
            : userAudioProducer?.pause()
        "
      >
        Turn Microphone {{ userAudioProducer?.paused ? "On" : "Off" }}
      </button>
      <button
        v-if="displayVideoProducer"
        @click="
          displayVideoProducer?.paused
            ? displayVideoProducer.resume()
            : displayVideoProducer?.pause()
        "
      >
        Screen Video {{ displayVideoProducer?.paused ? "On" : "Off" }}
      </button>
      <button
        v-if="displayAudioProducer"
        @click="
          displayAudioProducer?.paused
            ? displayAudioProducer.resume()
            : displayAudioProducer?.pause()
        "
      >
        Screen Audio {{ displayAudioProducer?.paused ? "On" : "Off" }}
      </button>
    </div>
    <div class="not-playing" v-if="currentRoomName && !isStreamer">
      <p>If the stream doesn't play:</p>
      <button
        @click="
          videoEl?.play();
          videoEl2?.play();
          audioEl?.play();
          audioEl2?.play();
        "
      >
        Play Stream
      </button>
    </div>
    <div
      class="stream"
      style="
        display: grid;
        grid-template-columns: 1fr 1fr;
        justify-content: center;
        align-items: center;
        margin: 10px;
        gap: 10px;
      "
    >
      <video autoplay playsinline ref="videoEl"></video>
      <video autoplay playsinline ref="videoEl2"></video>
      <audio
        style="position: absolute; top: -200vh"
        autoplay
        playsinline
        ref="audioEl"
      ></audio>
      <audio
        style="position: absolute; top: -200vh"
        autoplay
        playsinline
        ref="audioEl2"
      ></audio>
    </div>

    <div class="viewers" v-if="currentRoomName">
      <h2>Viewers</h2>
      <div
        v-for="(_, socketid) in rooms?.[currentRoomName]?.members"
        :key="roomName"
      >
        <p>Socket ID: {{ socketid }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Socket, io } from "socket.io-client";
import * as mediasoup from "mediasoup-client";
import {
  createRoom,
  joinRoom,
  RoomClient,
  subscribeSocketToRooms,
} from "~/utils";

const rerenderKey = ref(0);

const currentRoomName = ref(useRoute().query.room as string | undefined);
const isStreamer = ref(false);

const videoEl = useTemplateRef("videoEl");
const videoEl2 = useTemplateRef("videoEl2");
const audioEl = useTemplateRef("audioEl");
const audioEl2 = useTemplateRef("audioEl2");

const roomName = ref("");
const roomError = ref("");

let client: RoomClient | null = null;

let rooms = ref(
  null as {
    [key: string]: {
      rtpCapabilities: any;
      members: {
        [key: string]: {
          audioProducerIds: string[];
          videoProducerIds: string[];
          consumerIds: string[];
        };
      };
    };
  } | null
);

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

let userVideoProducer = ref(null as mediasoup.types.Producer | null);
let userAudioProducer = ref(null as mediasoup.types.Producer | null);
let displayVideoProducer = ref(null as mediasoup.types.Producer | null);
let displayAudioProducer = ref(null as mediasoup.types.Producer | null);

if (import.meta.client) {
  socket = io("/", {
    path: "/api/ws/socket.io",
  });

  socket.on("connect", async () => {
    console.log("Connected to server");

    rooms = subscribeSocketToRooms(socket!);
    if (currentRoomName.value)
      socket!.once("rooms-updated", () => joinTheRoom());
    rerenderKey.value++;
  });
}

const createStream = async () => {
  try {
    await createRoom({ name: roomName.value, socket: socket! });
  } catch (error) {
    roomError.value = error as string;
  }

  isStreamer.value = true;
  currentRoomName.value = roomName.value;
  history.replaceState(null, "", `/stream?room=${roomName.value}`);

  client = await joinRoom({ room: roomName.value, socket: socket! });

  const userMedia = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });

  const displayMedia = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  if (userMedia.getVideoTracks().length > 0) {
    userVideoProducer.value = await client.createProducer({
      track: userMedia.getVideoTracks()[0]!,
    });

    const videoConsumer = await client.createConsumer({
      producerId: userVideoProducer.value.id,
      producerKind: "video",
    });

    const stream = new MediaStream();
    videoConsumer.on("trackended", () => {
      stream.removeTrack(videoConsumer.track);
      console.log("Track ended");
    });
    stream.addTrack(videoConsumer.track);
    videoEl.value!.srcObject = stream;
  }

  if (displayMedia.getVideoTracks().length > 0) {
    displayVideoProducer.value = await client.createProducer({
      track: displayMedia.getVideoTracks()[0]!,
    });

    const videoConsumer = await client.createConsumer({
      producerId: displayVideoProducer.value.id,
      producerKind: "video",
    });

    const stream = new MediaStream();
    videoConsumer.on("trackended", () => {
      stream.removeTrack(videoConsumer.track);
      console.log("Track ended");
    });
    stream.addTrack(videoConsumer.track);
    videoEl2.value!.srcObject = stream;
  }

  if (userMedia.getAudioTracks().length > 0) {
    userAudioProducer.value = await client.createProducer({
      track: userMedia.getAudioTracks()[0]!,
    });
  }

  if (displayMedia.getAudioTracks().length > 0) {
    displayAudioProducer.value = await client.createProducer({
      track: displayMedia.getAudioTracks()[0]!,
    });
  }
};

const joinTheRoom = async () => {
  console.log("Connecting to room:", currentRoomName.value);
  client = await joinRoom({ room: currentRoomName.value!, socket: socket! });

  const members = toRaw(rooms.value![currentRoomName.value!]!.members);

  for (const [socketid, data] of Object.entries(members)) {
    if (data.videoProducerIds.length > 0) {
      const videoConsumer = await client.createConsumer({
        producerId: data.videoProducerIds[0]!,
        producerKind: "video",
      });

      const stream = new MediaStream();
      videoConsumer.on("trackended", () => {
        stream.removeTrack(videoConsumer.track);
        console.log("Track ended");
      });
      stream.addTrack(videoConsumer.track);
      videoEl.value!.srcObject = stream;
      if (data.videoProducerIds.length > 1) {
        const videoConsumer2 = await client.createConsumer({
          producerId: data.videoProducerIds[1]!,
          producerKind: "video",
        });

        const stream2 = new MediaStream();
        videoConsumer2.on("trackended", () => {
          stream2.removeTrack(videoConsumer2.track);
          console.log("Track ended");
        });
        stream2.addTrack(videoConsumer2.track);
        videoEl2.value!.srcObject = stream2;
        1;
      }
    }
    if (data.audioProducerIds.length > 0) {
      const audioConsumer = await client.createConsumer({
        producerId: data.audioProducerIds[0]!,
        producerKind: "audio",
      });

      const stream = new MediaStream();
      audioConsumer.on("trackended", () => {
        stream.removeTrack(audioConsumer.track);
        console.log("Track ended");
      });
      stream.addTrack(audioConsumer.track);
      audioEl.value!.srcObject = stream;

      if (data.audioProducerIds.length > 1) {
        const audioConsumer2 = await client.createConsumer({
          producerId: data.audioProducerIds[1]!,
          producerKind: "audio",
        });

        const stream2 = new MediaStream();
        audioConsumer2.on("trackended", () => {
          stream2.removeTrack(audioConsumer2.track);
          console.log("Track ended");
        });
        stream2.addTrack(audioConsumer2.track);
        audioEl2.value!.srcObject = stream2;
      }
    }
  }
};

const leaveTheRoom = async () => {
  await client?.close();
};
</script>
