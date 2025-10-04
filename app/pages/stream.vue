<template>
  <div :key="rerenderKey">
    <h1 v-if="currentRoomName">Room: {{ currentRoomName }}</h1>
    <h1 v-else>Start a stream</h1>

    <div class="start-stream" v-if="!currentRoomName">
      <input type="text" v-model="roomName" @input="roomError = ''" />
      <button @click="createStream">Create Stream</button>
    </div>

    <button v-if="currentRoomName" @click="leaveTheRoom">Leave Room</button>
    <div class="stream">
      <video autoplay playsinline ref="videoEl"></video>
      <audio autoplay playsinline ref="audioEl"></audio>
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
const audioEl = useTemplateRef("audioEl");

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

if (import.meta.client) {
  socket = io("/", {
    path: "/api/ws/socket.io",
  });

  socket.on("connect", async () => {
    console.log("Connected to server");

    rooms = subscribeSocketToRooms(socket!);
    if (currentRoomName.value) joinTheRoom();
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

  if (userMedia.getVideoTracks().length > 0) {
    const videoProducer = await client.createProducer({
      track: userMedia.getVideoTracks()[0]!,
    });

    const videoConsumer = await client.createConsumer({
      producerId: videoProducer.id,
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

  if (userMedia.getAudioTracks().length > 0) {
    const audioProducer = await client.createProducer({
      track: userMedia.getAudioTracks()[0]!,
    });
  }
};

const joinTheRoom = async () => {
  client = await joinRoom({ room: currentRoomName.value!, socket: socket! });

  const members = rooms.value![currentRoomName.value!]!.members;

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
    }
    if (data.videoProducerIds.length > 0) {
      const audioConsumer = await client.createConsumer({
        producerId: data.videoProducerIds[0]!,
        producerKind: "audio",
      });

      const stream = new MediaStream();
      audioConsumer.on("trackended", () => {
        stream.removeTrack(audioConsumer.track);
        console.log("Track ended");
      });
      stream.addTrack(audioConsumer.track);
      audioEl.value!.srcObject = stream;
    }
  }
};

const leaveTheRoom = async () => {
  await client?.close();
};
</script>
