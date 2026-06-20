import asyncio
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as SM

async def run():
    m = await SM.request_async()
    s = m.get_current_session()
    if not s:
        print("No active session.")
        return
    p = await s.try_get_media_properties_async()
    if p and p.thumbnail:
        print("Thumbnail available.")
        stream = await p.thumbnail.open_read_async()
        print(f"Stream size: {stream.size}")
        
        # Read stream to bytes
        from winrt.windows.storage.streams import DataReader
        reader = DataReader(stream)
        await reader.load_async(stream.size)
        buffer = reader.read_buffer(stream.size)
        
        # Convert IBuffer to bytes
        # MemoryBuffer or just bytes(buffer)
        b = bytes(buffer)
        print(f"Read {len(b)} bytes.")
        
        with open("test_thumb.jpg", "wb") as f:
            f.write(b)
        print("Saved test_thumb.jpg")
    else:
        print("No thumbnail.")

asyncio.run(run())
