import { GameRoom } from './GameRoom.js';

export function setupSocketHandlers(io) {
  const room = new GameRoom(io);
  io.on('connection', (socket) => {
    console.log(`🔌 Novo jogador conectado: ${socket.id}`);
    socket.on('join_arena', async (data) => room.addPlayer(socket, data || {}));
    socket.on('player_input', (data) => room.handlePlayerInput(socket.id, data || {}));
    socket.on('cashout_request', async (data) => room.handleCashout(socket.id, data || {}));
    socket.on('leave_safe_house', () => room.handleLeaveSafeHouse(socket.id));
    socket.on('disconnect', () => {
      console.log(`🔌 Jogador desconectado: ${socket.id}`);
      room.removePlayer(socket.id);
    });
  });
  return room;
}