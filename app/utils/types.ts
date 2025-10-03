import * as mediasoup from "mediasoup-client";
import type { Socket } from "socket.io-client";

type ErrorType =
  | "RoomAlreadyExists"
  | "RoomDoesNotExist"
  | "TransportCannotConsumeProducer"
  | "TransportDoesNotExist"
  | "TransportIsNotAConsumer"
  | "Unauthorized";

export type Result<T> = {
  result?: T;
  error?: {
    type: ErrorType;
    desc?: string;
    details?: any;
  };
};

export interface ServerToClientEvents {
  "rooms-updated": (
    data: Result<{
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
    }>
  ) => void;
}

export interface ClientToServerEvents {
  "create-room": (
    payload: { room: string },
    callback: (
      data: Result<{
        rtpCapabilities: mediasoup.types.RtpCapabilities;
      }>
    ) => void
  ) => void;
  "join-room": (
    payload: { room: string },
    callback: (
      data: Result<{
        id: string;
        iceParameters: mediasoup.types.IceParameters;
        iceCandidates: mediasoup.types.IceCandidate[];
        dtlsParameters: mediasoup.types.DtlsParameters;
      }>
    ) => void
  ) => void;
  "connect-transport": (
    payload: {
      transportId: string;
      dtlsParameters: mediasoup.types.DtlsParameters;
    },
    callback: (data: Result<null>) => void
  ) => void;
  "transport-produce": (
    payload: {
      transportId: string;
      kind: "audio" | "video";
      rtpParameters: mediasoup.types.RtpParameters;
    },
    callback: (data: Result<{ id: string }>) => void
  ) => void;
  "transport-consume": (
    payload: {
      transportId: string;
      producerId: string;
      rtpCapabilities: mediasoup.types.RtpCapabilities;
    },
    callback: (
      data: Result<{
        id: string;
        rtpParameters: mediasoup.types.RtpParameters;
      }>
    ) => void
  ) => void;
  "resume-consume": (
    payload: { transportId: string },
    callback: (data: Result<null>) => void
  ) => void;
}

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
