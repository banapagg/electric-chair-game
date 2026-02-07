const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const playerRoomMap = new Map(); // ws -> roomCode

// --- HTTP Server (static file serving) ---
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// --- WebSocket Server ---
const wss = new WebSocketServer({ server });

function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(roomCode) {
  return {
    roomCode,
    players: [], // [{ ws, id, name }]
    state: {
      phase: 'WAITING', // WAITING, SET_TRAP, CHOOSE_CHAIR, REVEAL, GAME_OVER
      inning: 1,
      chairs: Array(12).fill(true), // available chairs
      scores: { p1: 0, p2: 0 },
      outs: { p1: 0, p2: 0 },
      innings: { p1: Array(8).fill(null), p2: Array(8).fill(null) },
      trapChair: null,
      chosenChair: null,
      currentSetter: 'p2', // p2 sets trap first (matching original game)
      currentSitter: 'p1',
      revealAcks: 0,
    },
  };
}

function send(ws, msg) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function getPlayer(room, id) {
  return room.players.find(p => p.id === id);
}

function getOpponent(room, id) {
  return room.players.find(p => p.id !== id);
}

function getPlayerId(room, ws) {
  const p = room.players.find(p => p.ws === ws);
  return p ? p.id : null;
}

function broadcastGameState(room) {
  const s = room.state;
  const base = {
    inning: s.inning,
    scores: s.scores,
    outs: s.outs,
    innings: s.innings,
    chairs: s.chairs,
  };
  return base;
}

function startSetTrapPhase(room) {
  const s = room.state;
  s.phase = 'SET_TRAP';
  s.trapChair = null;
  s.chosenChair = null;
  s.revealAcks = 0;

  const gameState = broadcastGameState(room);
  const setter = getPlayer(room, s.currentSetter);
  const sitter = getPlayer(room, s.currentSitter);

  if (setter) {
    send(setter.ws, {
      type: 'YOUR_TURN_SET_TRAP',
      ...gameState,
      setterName: setter.name,
      sitterName: sitter ? sitter.name : '???',
    });
  }
  if (sitter) {
    send(sitter.ws, {
      type: 'WAIT_FOR_TRAP',
      ...gameState,
      setterName: setter ? setter.name : '???',
      sitterName: sitter.name,
    });
  }
}

function startChooseChairPhase(room) {
  const s = room.state;
  s.phase = 'CHOOSE_CHAIR';

  const gameState = broadcastGameState(room);
  const setter = getPlayer(room, s.currentSetter);
  const sitter = getPlayer(room, s.currentSitter);

  if (sitter) {
    send(sitter.ws, {
      type: 'YOUR_TURN_CHOOSE_CHAIR',
      ...gameState,
      setterName: setter ? setter.name : '???',
      sitterName: sitter.name,
    });
  }
  if (setter) {
    send(setter.ws, {
      type: 'WAIT_FOR_CHOICE',
      ...gameState,
      setterName: setter.name,
      sitterName: sitter ? sitter.name : '???',
    });
  }
}

function checkWinner(room) {
  const s = room.state;
  if (s.scores.p1 >= 40) return { winner: 'p1', reason: 'score' };
  if (s.scores.p2 >= 40) return { winner: 'p2', reason: 'score' };
  if (s.outs.p1 >= 3) return { winner: 'p2', reason: 'outs' };
  if (s.outs.p2 >= 3) return { winner: 'p1', reason: 'outs' };
  return null;
}

function handleMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }

  switch (msg.type) {
    case 'CREATE_ROOM': {
      const name = (msg.playerName || 'Player 1').slice(0, 10);
      const roomCode = generateRoomCode();
      const room = createRoom(roomCode);
      room.players.push({ ws, id: 'p1', name });
      rooms.set(roomCode, room);
      playerRoomMap.set(ws, roomCode);
      send(ws, { type: 'ROOM_CREATED', roomCode, yourId: 'p1' });
      break;
    }

    case 'JOIN_ROOM': {
      const code = (msg.roomCode || '').toUpperCase().trim();
      const name = (msg.playerName || 'Player 2').slice(0, 10);
      const room = rooms.get(code);

      if (!room) {
        send(ws, { type: 'ERROR', message: 'ルームが見つかりません' });
        return;
      }
      if (room.players.length >= 2) {
        send(ws, { type: 'ERROR', message: 'ルームが満員です' });
        return;
      }

      room.players.push({ ws, id: 'p2', name });
      playerRoomMap.set(ws, code);

      const p1 = getPlayer(room, 'p1');
      send(ws, {
        type: 'ROOM_JOINED',
        roomCode: code,
        yourId: 'p2',
        opponentName: p1.name,
      });
      send(p1.ws, {
        type: 'OPPONENT_JOINED',
        opponentName: name,
      });

      // Start the game after a short delay
      setTimeout(() => startSetTrapPhase(room), 1000);
      break;
    }

    case 'SET_TRAP': {
      const roomCode = playerRoomMap.get(ws);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room) return;
      const s = room.state;
      const playerId = getPlayerId(room, ws);

      if (s.phase !== 'SET_TRAP' || playerId !== s.currentSetter) {
        send(ws, { type: 'ERROR', message: '今はトラップを仕掛けるタイミングではありません' });
        return;
      }

      const chair = msg.chair;
      if (!Number.isInteger(chair) || chair < 1 || chair > 12 || !s.chairs[chair - 1]) {
        send(ws, { type: 'ERROR', message: '無効な椅子です' });
        return;
      }

      s.trapChair = chair;
      send(ws, { type: 'TRAP_SET_OK' });
      startChooseChairPhase(room);
      break;
    }

    case 'CHOOSE_CHAIR': {
      const roomCode = playerRoomMap.get(ws);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room) return;
      const s = room.state;
      const playerId = getPlayerId(room, ws);

      if (s.phase !== 'CHOOSE_CHAIR' || playerId !== s.currentSitter) {
        send(ws, { type: 'ERROR', message: '今は椅子を選ぶタイミングではありません' });
        return;
      }

      const chair = msg.chair;
      if (!Number.isInteger(chair) || chair < 1 || chair > 12 || !s.chairs[chair - 1]) {
        send(ws, { type: 'ERROR', message: '無効な椅子です' });
        return;
      }

      s.chosenChair = chair;
      s.phase = 'REVEAL';

      // Compute result
      const isShock = s.chosenChair === s.trapChair;
      let scoreGained = 0;

      if (isShock) {
        // OUT - sitter's score resets to 0
        s.scores[s.currentSitter] = 0;
        s.outs[s.currentSitter]++;
        s.innings[s.currentSitter][s.inning - 1] = 'OUT';
      } else {
        // SAFE - add chair number to score, remove chair
        scoreGained = chair;
        s.scores[s.currentSitter] += chair;
        s.innings[s.currentSitter][s.inning - 1] = chair;
        s.chairs[chair - 1] = false;
      }

      const revealMsg = {
        type: 'REVEAL',
        chosenChair: s.chosenChair,
        trapChair: s.trapChair,
        result: isShock ? 'OUT' : 'SAFE',
        scoreGained,
        scores: s.scores,
        outs: s.outs,
        innings: s.innings,
        chairs: s.chairs,
        inning: s.inning,
        sitterId: s.currentSitter,
      };

      // Send to both players
      room.players.forEach(p => send(p.ws, revealMsg));
      break;
    }

    case 'REVEAL_ACK': {
      const roomCode = playerRoomMap.get(ws);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room || room.state.phase !== 'REVEAL') return;

      room.state.revealAcks++;

      if (room.state.revealAcks >= 2) {
        const s = room.state;

        // Check win conditions
        const winResult = checkWinner(room);
        if (winResult) {
          s.phase = 'GAME_OVER';
          const winnerPlayer = getPlayer(room, winResult.winner);
          room.players.forEach(p => {
            send(p.ws, {
              type: 'GAME_OVER',
              winnerId: winResult.winner,
              winnerName: winnerPlayer ? winnerPlayer.name : '???',
              reason: winResult.reason,
              scores: s.scores,
              outs: s.outs,
              innings: s.innings,
            });
          });
          return;
        }

        // Check if we need to advance inning
        // p2 sets trap first (for p1), then p1 sets trap (for p2) = 1 inning
        const wasSetter = s.currentSetter;
        if (wasSetter === 'p1') {
          // Both sides done, advance inning
          s.inning++;
          if (s.inning > 8) {
            // 8 innings complete - final judgement
            s.phase = 'GAME_OVER';
            let winnerId, winnerName;
            if (s.scores.p1 > s.scores.p2) {
              winnerId = 'p1';
            } else if (s.scores.p2 > s.scores.p1) {
              winnerId = 'p2';
            } else {
              winnerId = 'draw';
            }
            const wp = winnerId !== 'draw' ? getPlayer(room, winnerId) : null;
            winnerName = wp ? wp.name : '引き分け';

            room.players.forEach(p => {
              send(p.ws, {
                type: 'GAME_OVER',
                winnerId,
                winnerName,
                reason: 'innings',
                scores: s.scores,
                outs: s.outs,
                innings: s.innings,
              });
            });
            return;
          }
        }

        // Swap roles
        const prevSetter = s.currentSetter;
        s.currentSetter = s.currentSitter;
        s.currentSitter = prevSetter;

        // Start next trap phase
        setTimeout(() => startSetTrapPhase(room), 1500);
      }
      break;
    }

    case 'PLAY_AGAIN': {
      const roomCode = playerRoomMap.get(ws);
      if (!roomCode) return;
      const room = rooms.get(roomCode);
      if (!room || room.state.phase !== 'GAME_OVER') return;

      // Reset state
      room.state = {
        phase: 'WAITING',
        inning: 1,
        chairs: Array(12).fill(true),
        scores: { p1: 0, p2: 0 },
        outs: { p1: 0, p2: 0 },
        innings: { p1: Array(8).fill(null), p2: Array(8).fill(null) },
        trapChair: null,
        chosenChair: null,
        currentSetter: 'p2',
        currentSitter: 'p1',
        revealAcks: 0,
      };

      room.players.forEach(p => send(p.ws, { type: 'GAME_RESET' }));
      setTimeout(() => startSetTrapPhase(room), 1000);
      break;
    }
  }
}

function handleDisconnect(ws) {
  const roomCode = playerRoomMap.get(ws);
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  if (!room) return;

  const opponent = room.players.find(p => p.ws !== ws);
  if (opponent) {
    send(opponent.ws, { type: 'OPPONENT_DISCONNECTED' });
  }

  // Clean up
  playerRoomMap.delete(ws);
  room.players = room.players.filter(p => p.ws !== ws);

  // Remove room if empty
  if (room.players.length === 0) {
    rooms.delete(roomCode);
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => handleMessage(ws, data.toString()));
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

// --- Start Server ---
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ 電気イスゲーム サーバー起動 ⚡\n`);

  // Show local IP addresses
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }

  console.log(`ローカル:     http://localhost:${PORT}`);
  addresses.forEach(addr => {
    console.log(`ネットワーク: http://${addr}:${PORT}`);
  });
  console.log(`\n同じWiFiのデバイスから上記URLにアクセスしてください\n`);
});
