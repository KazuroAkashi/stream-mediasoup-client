<template>
  <div>
    <h1>Stream Test</h1>

    <video autoplay playsinline ref="videoEl"></video>
    <audio autoplay playsinline ref="audioEl"></audio>

    <div class="consuming" ref="consumingList"></div>

    <div class="create-room">
      <input type="text" v-model="roomName" @input="roomError = ''" />
      <button @click="createNewRoom">Create Room</button>
      <p>{{ roomError }}</p>
    </div>
    <div class="rooms">
      <h2>Open Rooms</h2>
      <div v-for="[roomName, _] in rooms" :key="roomName">
        <button @click="joinARoom(roomName)">{{ roomName }}</button>
      </div>
    </div>

    <div class="connected-rooms">
      <h2>Connected Rooms</h2>
      <div v-for="[roomName, _] in clients" :key="roomName">
        <div
          v-for="[socketid, member] in rooms?.get(roomName)?.members"
          class="member"
        >
          <p>Socket ID: {{ socketid }}</p>
          <button
            v-for="id in member.producerIds"
            :key="id"
            @click="consumeProducer(id, roomName)"
          >
            Consume Producer ID: {{ id }}
          </button>
        </div>
        <button @click="leaveARoom(roomName)">
          Disconnect from {{ roomName }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Socket, io } from "socket.io-client";
import { createRoom, joinRoom, subscribeSocketToRooms } from "~/utils";

const consumingList = useTemplateRef("consumingList");
const videoEl = useTemplateRef("videoEl");
const audioEl = useTemplateRef("audioEl");

const roomName = ref("");
const roomError = ref("");

const clients = ref(new Map<string, RoomClient>());

let rooms = ref(
  null as Map<
    string,
    {
      rtpCapabilities: any;
      members: Map<string, { producerIds: string[]; consumerIds: string[] }>;
    }
  > | null
);

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

if (import.meta.client) {
  socket = io("/", {
    path: "/api/ws/socket.io",
  });

  socket.on("connect", async () => {
    console.log("Connected to server");

    rooms = subscribeSocketToRooms(socket!);
  });
}

const createNewRoom = async () => {
  try {
    await createRoom({ name: roomName.value, socket: socket! });
  } catch (error) {
    roomError.value = error as string;
  }
};

const joinARoom = async (roomName: string) => {
  const client = await joinRoom({ room: roomName, socket: socket! });

  clients.value.set(roomName, client);
};

const leaveARoom = async (roomName: string) => {
  const client = clients.value.get(roomName)!;
  await client.close();
  clients.value.delete(roomName);
};

const consumeProducer = async (producerId: string, roomName: string) => {
  const client = clients.value.get(roomName)!;
  const videoConsumer = await client
    .createConsumer({ producerId, producerKind: "video" })
    .catch(() => null);
  const audioConsumer = await client
    .createConsumer({ producerId, producerKind: "audio" })
    .catch(() => null);

  if (videoConsumer === null && audioConsumer === null) {
    alert("Could not consume");
    return;
  }

  if (videoConsumer !== null) {
    const el = document.createElement("video");
    el.playsInline = true;
    el.autoplay = true;
    consumingList.value?.appendChild(el);

    const stream = new MediaStream();
    videoConsumer.track.addEventListener("ended", () => {
      stream.removeTrack(videoConsumer.track);
      consumingList.value?.removeChild(el);
      console.log("Track ended");
    });
    stream.addTrack(videoConsumer.track);
    el.srcObject = stream;
  }
  if (audioConsumer !== null) {
    const el = document.createElement("audio");
    el.autoplay = true;
    consumingList.value?.appendChild(el);

    const stream = new MediaStream();
    audioConsumer.track.addEventListener("ended", () => {
      stream.removeTrack(audioConsumer.track);
      consumingList.value?.removeChild(el);
      console.log("Track ended");
    });
    stream.addTrack(audioConsumer.track);
    el.srcObject = stream;
  }
};

const initiateConnection = async () => {
  const client = await joinRoom({ room: "room-1", socket: socket! });

  const userMedia = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
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
