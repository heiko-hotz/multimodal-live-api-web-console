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

import { useRef, useState } from "react";
import "./App.scss";
import { LiveAPIProvider } from "./contexts/LiveAPIContext";
import SidePanel from "./components/side-panel/SidePanel";
import { Altair } from "./components/altair/Altair";
import ControlTray from "./components/control-tray/ControlTray";
import cn from "classnames";

const PROXY_URL = process.env.REACT_APP_PROXY_URL || "ws://localhost:8080";

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [bearerToken, setBearerToken] = useState("");
  const [projectId, setProjectId] = useState("");

  return (
    <div className="App">
      <LiveAPIProvider 
        url={PROXY_URL} 
        bearerToken={bearerToken}
        projectId={projectId}
      >
        <div className="streaming-console">
          <div className="form-container">
            <div className="form-row">
              <label>Project ID:</label>
              <input 
                type="text" 
                value={projectId} 
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="your-project-id"
              />
            </div>
            <div className="form-row">
              <label>Bearer Token:</label>
              <input 
                type="password" 
                value={bearerToken} 
                onChange={(e) => setBearerToken(e.target.value)}
                placeholder="Bearer token from gcloud auth print-access-token"
              />
            </div>
          </div>
          <SidePanel />
          <main>
            <div className="main-app-area">
              {/* APP goes here */}
              <Altair />
              <video
                className={cn("stream", {
                  hidden: !videoRef.current || !videoStream,
                })}
                ref={videoRef}
                autoPlay
                playsInline
              />
            </div>

            <ControlTray
              videoRef={videoRef}
              supportsVideo={true}
              onVideoStreamChange={setVideoStream}
            >
              {/* put your own buttons here */}
            </ControlTray>
          </main>
        </div>
      </LiveAPIProvider>
    </div>
  );
}

export default App;
