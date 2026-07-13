import Fastify from 'fastify';

const fastify = Fastify({ logger: false });

// Wake-up endpoint
fastify.get('/', async () => {
  return { ok: true, time: Date.now() };
});

const sessions = new Map();
const codes = new Map();
// Queues: pending[code_role] = [] array of messages
const pending = new Map();

function generateCode() {
  let code = '';
  for (let i = 0; i < 9; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

function enqueue(key, msg) {
  if (!pending.has(key)) pending.set(key, []);
  pending.get(key).push(msg);
}

function dequeue(key) {
  const q = pending.get(key);
  if (q && q.length > 0) return q.shift();
  return null;
}

// Host registers, gets a code
fastify.post('/register', async (request, reply) => {
  const code = generateCode();
  const roomId = `room_${code}`;
  sessions.set(roomId, { code, viewerCode: null });
  codes.set(code, roomId);
  console.log(`✅ Host registered! Code: ${code}`);
  return { type: 'code', code };
});

// Viewer joins by code
fastify.post('/join', async (request, reply) => {
  const { code } = request.body || {};
  const roomId = codes.get(code);
  if (!roomId) {
    return reply.code(404).send({ type: 'error', msg: 'Invalid code' });
  }
  const session = sessions.get(roomId);
  if (!session) {
    return reply.code(404).send({ type: 'error', msg: 'Session expired' });
  }
  if (session.viewerCode) {
    return reply.code(400).send({ type: 'error', msg: 'Already have a viewer' });
  }
  session.viewerCode = code + '_viewer';
  console.log(`✅ Viewer connected to code: ${code}`);

  // Notify host
  enqueue(`poll_host_${code}`, { type: 'viewer-joined' });

  return { type: 'joined', roomId };
});

// Send signaling message (offer/answer/ice)
fastify.post('/signal', async (request, reply) => {
  const { code, type, sdp, candidate, role } = request.body || {};
  const roomId = codes.get(code);
  const session = roomId ? sessions.get(roomId) : null;
  if (!session) return reply.code(404).send({ type: 'error', msg: 'No session' });

  const targetRole = role === 'host' ? 'viewer' : 'host';
  const targetKey = `poll_${targetRole}_${code}`;

  if (type === 'offer') {
    enqueue(targetKey, { type: 'offer', sdp });
  } else if (type === 'answer') {
    enqueue(targetKey, { type: 'answer', sdp });
  } else if (type === 'ice-candidate') {
    enqueue(targetKey, { type: 'ice-candidate', candidate, role });
  }

  return { ok: true };
});

// Long-polling: wait for messages
fastify.get('/poll/:role/:code', async (request, reply) => {
  const { role, code } = request.params;
  const key = `poll_${role}_${code}`;
  const timeout = 25000; // 25 seconds

  const start = Date.now();
  while (Date.now() - start < timeout) {
    const msg = dequeue(key);
    if (msg) {
      return reply.send(msg);
    }
    // Sleep 300ms before retry
    await new Promise(r => setTimeout(r, 300));
  }

  // Timeout - no messages
  return reply.send({ type: 'timeout' });
});

// Cleanup when host disconnects (call from client)
fastify.post('/disconnect', async (request, reply) => {
  const { code } = request.body || {};
  const roomId = codes.get(code);
  if (roomId) {
    const session = sessions.get(roomId);
    if (session) {
      // Notify viewer
      if (session.viewerCode) {
        enqueue(`poll_viewer_${code}`, { type: 'host-disconnected' });
      }
      codes.delete(session.code);
      sessions.delete(roomId);
      console.log(`❌ Room ${roomId} closed (host left)`);
    }
  }
  return { ok: true };
});

const port = parseInt(process.env.PORT || '3000', 10);
fastify.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`RemoteDeskPBX Server running on port ${port}`);
});