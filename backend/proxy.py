import asyncio
import json
import websockets
from websockets.legacy.protocol import WebSocketCommonProtocol
from websockets.legacy.server import WebSocketServerProtocol

HOST = "us-central1-aiplatform.googleapis.com"
SERVICE_URL = f"wss://{HOST}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent"

DEBUG = True

async def proxy_task(
    source_websocket: WebSocketCommonProtocol, 
    target_websocket: WebSocketCommonProtocol,
    name: str = ""
) -> None:
    """
    Forwards messages from one WebSocket connection to another.
    """
    try:
        async for message in source_websocket:
            try:
                data = json.loads(message)
                await target_websocket.send(json.dumps(data))
            except websockets.exceptions.ConnectionClosed as e:
                break
            except Exception as e:
                print(f"Error: {e}")
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        print(f"Error: {e}")

async def create_proxy(
    client_websocket: WebSocketCommonProtocol, bearer_token: str
) -> None:
    """
    Establishes a WebSocket connection to the server.
    """
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {bearer_token}",
    }

    try:
        async with websockets.connect(
            SERVICE_URL, additional_headers=headers
        ) as server_websocket:
            # Create two tasks for bidirectional communication
            client_to_server = asyncio.create_task(
                proxy_task(client_websocket, server_websocket, "Client->Server")
            )
            server_to_client = asyncio.create_task(
                proxy_task(server_websocket, client_websocket, "Server->Client")
            )
            
            try:
                # Wait for both tasks to complete
                await asyncio.gather(client_to_server, server_to_client)
            except Exception as e:
                print(f"Task error: {e}")
                print(f"Error type: {type(e)}")
                if hasattr(e, '__cause__'):
                    print(f"Caused by: {e.__cause__}")
    except Exception as e:
        print(f"Proxy connection error: {e}")
        print(f"Error type: {type(e)}")
        if hasattr(e, '__cause__'):
            print(f"Caused by: {e.__cause__}")

async def handle_client(client_websocket: WebSocketServerProtocol) -> None:
    """
    Handles a new client connection.
    """
    print("New connection...")
    try:
        # Wait for the first message from the client
        auth_message = await asyncio.wait_for(client_websocket.recv(), timeout=5.0)
        auth_data = json.loads(auth_message)

        if "bearer_token" in auth_data:
            bearer_token = auth_data["bearer_token"]
            await create_proxy(client_websocket, bearer_token)
        else:
            await client_websocket.close(code=1008, reason="Bearer token missing")
    except Exception as e:
        print(f"Error: {e}")
        await client_websocket.close(code=1011, reason="Internal error")

async def main() -> None:
    """
    Starts the WebSocket server.
    """
    async with websockets.serve(handle_client, "0.0.0.0", 8080):
        print("Running websocket server on 0.0.0.0:8080...")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
