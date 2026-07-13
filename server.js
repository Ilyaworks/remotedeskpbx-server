import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';

const fastify = Fastify({ logger: false });
fastify.register(fastifyWebSocket);

const sessions = new Map();
const codes = new Map();

function generateCode() {
  let code = '';
  for (let i = 0; i < 9; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

fastify.get('/ws', { websocket: true }, (socket) => {
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { type } = msg;

      if (type === 'register-host') {
        const code = generateCode();
        const roomId = `room_${code}`;
        sessions.set(roomId, { ws: socket, code, viewer: null });
        codes.set(code, roomId);
        console.log(`\n✅ Host registered! Code: ${code}`);
        socket.send(JSON.stringify({ type: 'code', code }));
        return;
      }

      if (type === 'join-viewer') {
        const { code } = msg;
        const roomId = codes.get(code);
        if (!roomId) {
          socket.send(JSON.stringify({ type: 'error', msg: 'Invalid code' }));
          return;
        }
        const session = sessions.get(roomId);
        if (!session) {
          socket.send(JSON.stringify({ type: 'error', msg: 'Session expired' }));
          return;
        }
        if (session.viewer) {
          socket.send(JSON.stringify({ type: 'error', msg: 'Already have a viewer' }));
          return;
        }
        session.viewer = socket;
        console.log(`✅ Viewer connected to code: ${code}`);
        socket.send(JSON.stringify({ type: 'joined', roomId }));
        session.ws.send(JSON.stringify({ type: 'viewer-joined' }));
        return;
      }

      // Forward WebRTC signaling
      const { code } = msg;
      const roomId = codes.get(code);
      const session = roomId ? sessions.get(roomId) : null;
      if (!session) return;

      if (type === 'offer') {
        if (session.viewer) session.viewer.send(raw.toString());
      } else if (type === 'answer') {
        session.ws.send(raw.toString());
      } else if (type === 'ice-candidate') {
        const target = msg.role === 'host' ? session.viewer : session.ws;
        if (target) target.send(raw.toString());
      }
    } catch {}
  });

  socket.on('close', () => {
    for (const [roomId, s] of sessions) {
      if (s.ws === socket) {
        if (s.viewer) s.viewer.send(JSON.stringify({ type: 'host-disconnected' }));
        codes.delete(s.code);
        sessions.delete(roomId);
        console.log(`❌ Room ${roomId} closed (host left)`);
        return;
      }
      if (s.viewer === socket) {
        s.viewer = null;
        s.ws.send(JSON.stringify({ type: 'viewer-disconnected' }));
        return;
      }
    }
  });
});

const port = parseInt(process.env.PORT || '3000', 10);
fastify.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`RemoteDeskPBX Server running on port ${port}`);
});