<template>
  <div class="video">
    <video
      controls
      autoplay
      playsinline
      ref="videoEl"
      style="width: 100%"
    ></video>
  </div>
</template>

<script setup lang="ts">
import Hls from "hls.js";

const id = useRoute().query.id;

const videoEl = ref<HTMLVideoElement | null>(null);

onMounted(() => {
  if (id === undefined || id === null || Array.isArray(id)) {
    alert("Invalid id");
    return;
  }

  if (!Hls.isSupported()) {
    alert("HLS is not supported");
    return;
  }

  const hls = new Hls();
  hls.loadSource(`/hls/${id.toString()}/recording.m3u8`);
  hls.attachMedia(videoEl.value!);
});
</script>
