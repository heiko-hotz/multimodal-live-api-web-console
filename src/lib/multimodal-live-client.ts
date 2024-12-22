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

import { Content, GenerativeContentBlob, Part } from "@google/generative-ai";
import { EventEmitter } from "eventemitter3";
import { difference } from "lodash";
import {
  ClientContentMessage,
  isInterrupted,
  isModelTurn,
  isServerContenteMessage,
  isSetupCompleteMessage,
  isToolCallCancellationMessage,
  isToolCallMessage,
  isTurnComplete,
  LiveIncomingMessage,
  ModelTurn,
  RealtimeInputMessage,
  ServerContent,
  SetupMessage,
  StreamingLog,
  ToolCall,
  ToolCallCancellation,
  ToolResponseMessage,
  type LiveConfig,
} from "../multimodal-live-types";
import { blobToJSON, base64ToArrayBuffer } from "./utils";

/**
 * the events that this client will emit
 */
interface MultimodalLiveClientEventTypes {
  open: () => void;
  log: (log: StreamingLog) => void;
  close: (event: CloseEvent) => void;
  audio: (data: ArrayBuffer) => void;
  content: (content: ModelTurn) => void;
  interrupted: () => void;
  setupcomplete: () => void;
  turncomplete: () => void;
  toolcall: (toolCall: ToolCall) => void;
  toolcallcancellation: (toolcallCancellation: ToolCallCancellation) => void;
}

export type MultimodalLiveAPIClientConnection = {
  url?: string;
};

/**
 * A event-emitting class that manages the connection to the websocket and emits
 * events to the rest of the application.
 * If you dont want to use react you can still use this.
 */
export class MultimodalLiveClient extends EventEmitter<MultimodalLiveClientEventTypes> {
  public ws: WebSocket | null = null;
  protected config: LiveConfig | null = null;
  public url: string = "";
  public getConfig() {
    return { ...this.config };
  }

  constructor({ url }: MultimodalLiveAPIClientConnection) {
    super();
    this.url = url || 'ws://localhost:8080';
    this.send = this.send.bind(this);
  }

  log(type: string, message: StreamingLog["message"]) {
    const log: StreamingLog = {
      date: new Date(),
      type,
      message,
    };
    this.emit("log", log);
  }

  connect(config: LiveConfig): Promise<boolean> {
    this.config = config;

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(this.url);
        
        ws.addEventListener("message", async (evt: MessageEvent) => {
          try {
            let data;
            if (evt.data instanceof Blob) {
              data = await blobToJSON(evt.data);
            } else {
              data = JSON.parse(evt.data);
            }
            
            // Handle setupComplete
            if (isSetupCompleteMessage(data)) {
              console.log("Setup complete received");
              this.emit("setupcomplete");
              return;
            }

            // Handle server content
            if (isServerContenteMessage(data)) {
              const { serverContent } = data;
              console.log("Received server content:", serverContent);
              
              if (isModelTurn(serverContent)) {
                const { parts } = serverContent.modelTurn;
                console.log("Model turn parts:", parts);
                
                // Handle text parts first
                const textParts = parts.filter(part => part.text);
                if (textParts.length > 0) {
                  console.log("Emitting text content");
                  this.emit("content", { modelTurn: { parts: textParts } });
                }

                // Handle audio parts
                const audioParts = parts.filter(
                  part => part.inlineData?.mimeType?.startsWith("audio/")
                );
                for (const part of audioParts) {
                  if (part.inlineData?.data) {
                    console.log("Emitting audio data");
                    const audioData = base64ToArrayBuffer(part.inlineData.data);
                    this.emit("audio", audioData);
                  }
                }
              }
            }
          } catch (error) {
            console.error("Error processing message:", error);
            console.error("Message was:", evt.data);
          }
        });

        ws.addEventListener("error", (ev: Event) => {
          this.disconnect(ws);
          const message = `Could not connect to "${this.url}"`;
          this.log(`server.${ev.type}`, message);
          reject(new Error(message));
        });

        ws.addEventListener("open", (ev: Event) => {
          this.log(`client.${ev.type}`, `connected to socket`);
          this.ws = ws; // Set ws before emitting open
          this.emit("open");

          ws.addEventListener("close", (ev: CloseEvent) => {
            this.disconnect(ws);
            this.log(`server.${ev.type}`, `disconnected ${ev.reason ? `with reason: ${ev.reason}` : ''}`);
            this.emit("close", ev);
          });

          resolve(true);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(ws?: WebSocket) {
    // could be that this is an old websocket and theres already a new instance
    // only close it if its still the correct reference
    if ((!ws || this.ws === ws) && this.ws) {
      this.ws.close();
      this.ws = null;
      this.log("client.close", `Disconnected`);
      return true;
    }
    return false;
  }

  /**
   * send realtimeInput, this is base64 chunks of "audio/pcm" and/or "image/jpg"
   */
  sendRealtimeInput(chunks: GenerativeContentBlob[]) {
    let hasAudio = false;
    let hasVideo = false;
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      if (ch.mimeType.includes("audio")) {
        hasAudio = true;
      }
      if (ch.mimeType.includes("image")) {
        hasVideo = true;
      }
      if (hasAudio && hasVideo) {
        break;
      }
    }
    const message =
      hasAudio && hasVideo
        ? "audio + video"
        : hasAudio
          ? "audio"
          : hasVideo
            ? "video"
            : "unknown";

    const data: RealtimeInputMessage = {
      realtimeInput: {
        mediaChunks: chunks,
      },
    };
    this._sendDirect(data);
    this.log(`client.realtimeInput`, message);
  }

  /**
   *  send a response to a function call and provide the id of the functions you are responding to
   */
  sendToolResponse(toolResponse: ToolResponseMessage["toolResponse"]) {
    const message: ToolResponseMessage = {
      toolResponse,
    };

    this._sendDirect(message);
    this.log(`client.toolResponse`, message);
  }

  /**
   * send normal content parts such as { text }
   */
  send(parts: Part | Part[], turnComplete: boolean = true) {
    parts = Array.isArray(parts) ? parts : [parts];
    const content: Content = {
      role: "user",
      parts,
    };

    const clientContentRequest: ClientContentMessage = {
      clientContent: {
        turns: [content],
        turnComplete,
      },
    };

    this._sendDirect(clientContentRequest);
    this.log(`client.send`, clientContentRequest);
  }

  /**
   *  used internally to send all messages
   *  don't use directly unless trying to send an unsupported message type
   */
  _sendDirect(request: object) {
    if (!this.ws) {
      throw new Error("WebSocket is not connected");
    }
    const str = JSON.stringify(request);
    this.ws.send(str);
  }
}
