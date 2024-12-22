/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MultimodalLiveClient } from "../lib/multimodal-live-client";
import { LiveConfig } from "../multimodal-live-types";
import { AudioStreamer } from "../lib/audio-streamer";
import { audioContext } from "../lib/utils";
import VolMeterWorket from "../lib/worklets/vol-meter";

export type UseLiveAPIResults = {
  client: MultimodalLiveClient;
  setConfig: (config: LiveConfig) => void;
  config: LiveConfig;
  connected: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  volume: number;
  send: (message: string) => void;
  currentResponse: string;
};

export function useLiveAPI({ 
  url,
  bearerToken,
  projectId 
}: { 
  url?: string;
  bearerToken?: string;
  projectId?: string;
}): UseLiveAPIResults {
  const [client] = useState(() => new MultimodalLiveClient({ url }));
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<LiveConfig>({
    model: projectId ? 
      `projects/${projectId}/locations/us-central1/publishers/google/models/gemini-2.0-flash-exp` : 
      "models/gemini-2.0-flash-exp",
  });
  
  // Add back the state variables
  const [volume, setVolume] = useState(0);
  const [currentResponse, setCurrentResponse] = useState("");
  
  // Wait for setupComplete before allowing messages
  const [setupComplete, setSetupComplete] = useState(false);

  useEffect(() => {
    const onSetupComplete = () => {
      console.log("Setup complete");
      setSetupComplete(true);
    };

    client.on("setupcomplete", onSetupComplete);
    
    // Return cleanup function
    return () => {
      client.off("setupcomplete", onSetupComplete);
    };
  }, [client]);

  // Register audio for streaming server -> speakers
  useEffect(() => {
    if (!audioStreamerRef.current) {
      console.log("Setting up audio context...");
      audioContext({ id: "audio-out", sampleRate: 24000 }).then((audioCtx: AudioContext) => {
        console.log("Audio context created:", {
          sampleRate: audioCtx.sampleRate,
          state: audioCtx.state
        });
        audioStreamerRef.current = new AudioStreamer(audioCtx);
        console.log("Audio streamer created");
        audioStreamerRef.current
          .addWorklet<any>("vumeter-out", VolMeterWorket, (ev: any) => {
            setVolume(ev.data.volume);
          })
          .then(() => {
            console.log("Audio worklet added successfully");
          })
          .catch(err => {
            console.error("Error adding worklet:", err);
          });
      }).catch(err => {
        console.error("Error creating audio context:", err);
      });
    }
  }, [audioStreamerRef]);

  useEffect(() => {
    const onClose = () => {
      setConnected(false);
    };

    const stopAudioStreamer = () => {
      console.log("Stopping audio streamer");
      audioStreamerRef.current?.stop();
    };

    const onAudio = (data: ArrayBuffer) => {
      console.log("Audio handler received data, length:", data.byteLength);
      try {
        if (!audioStreamerRef.current) {
          console.error("No audio streamer available!");
          return;
        }

        // Check if AudioContext is running
        const audioCtx = audioStreamerRef.current.context;
        console.log("Audio context state:", audioCtx.state);
        if (audioCtx.state !== 'running') {
          console.log("Resuming audio context...");
          audioCtx.resume();
        }

        // The data is PCM 16-bit audio at 24kHz
        const audioData = new Int16Array(data);
        console.log("Converting audio data, samples:", audioData.length);
        
        const uint8Data = new Uint8Array(audioData.buffer);
        console.log("Converted to Uint8Array, length:", uint8Data.length);
        
        audioStreamerRef.current.addPCM16(uint8Data);
        console.log("Audio data sent to streamer");
      } catch (error: any) {
        console.error("Error processing audio:", error);
        if (error?.stack) {
          console.error(error.stack);
        }
      }
    };

    const onContent = (content: any) => {
      console.log("Content event received:", content);
      
      // Handle text content
      if (content?.modelTurn?.parts) {
        const textParts = content.modelTurn.parts.filter((p: any) => p.text);
        for (const part of textParts) {
          console.log("Adding text:", part.text);
          setCurrentResponse((prev: string) => prev + part.text);
        }
      }
    };

    client
      .on("close", onClose)
      .on("interrupted", stopAudioStreamer)
      .on("audio", onAudio)
      .on("content", onContent);

    return () => {
      client
        .off("close", onClose)
        .off("interrupted", stopAudioStreamer)
        .off("audio", onAudio)
        .off("content", onContent);
    };
  }, [client]);

  const connect = useCallback(async () => {
    if (!bearerToken) {
      console.error('Bearer token is required');
      return;
    }

    try {
      await client.connect(config);
      
      // First auth
      client._sendDirect({
        bearer_token: bearerToken
      });

      // Then setup - construct full model path
      const fullModelPath = `projects/${projectId}/locations/us-central1/publishers/google/models/gemini-2.0-flash-exp`;
      
      client._sendDirect({
        setup: {
          model: fullModelPath,  // Use full path here, not just projectId
          generation_config: { 
            response_modalities: ["AUDIO"],
            speech_config: {
              voice_config: {
                prebuilt_voice_config: {
                  voice_name: "Puck"
                }
              }
            }
          },
        },
      });

      setConnected(true);
    } catch (error) {
      console.error('Connection failed:', error);
      setConnected(false);
    }
  }, [client, config, bearerToken, projectId]);

  const disconnect = useCallback(async () => {
    try {
      // First stop audio
      if (audioStreamerRef.current) {
        audioStreamerRef.current.stop();
      }
      
      // Then disconnect websocket
      await client.disconnect();
      
      setConnected(false);
    } catch (error) {
      console.error('Error during disconnect:', error);
    }
  }, [client]);

  const send = useCallback((message: string) => {
    if (!client.ws || !setupComplete) {
      console.log("Not ready to send messages");
      return;
    }

    client._sendDirect({
      client_content: {
        turns: [
          {
            role: "user",
            parts: [{ text: message }]
          }
        ],
        turn_complete: true
      }
    });
  }, [client, setupComplete]);

  return {
    client,
    config,
    setConfig,
    connected,
    connect,
    disconnect,
    volume,
    send,
    currentResponse,
  };
}
