'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

const PORT = Number(process.env.PORT || 3000);
const ROWS = 10;
const COLS = 6;
const RECONNECT_GRACE_MS = 30_000;
const TIMER_TICK_MS = 500;

const TIME_CONTROLS = Object.freeze({
  '1+0': 60_000,
  '3+0': 180_000,
  '5+0': 300_000,
  '10+0': 600_000
});

const games = new Map(); // gameId -> game
const socketToGame = new Map(); // socket.id -> gameId
const socketToToken = new Map(); // socket.id -> token
const tokenToGame = new Map(); // token -> { gameId, playerIndex }
const waitingQueues = new Map(Object.keys(TIME_CONTROLS).map(key => [key, []]));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, games: games.size, uptime: process.uptime() });
});

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeName(name, fallback) {
  const value = typeof name === 'string' ? name.trim() : '';
  return value.slice(0, 24) || fallback;
}

function normalizeTimeControl(value) {
  return Object.prototype.hasOwnProperty.call(TIME_CONTROLS, value) ? value : '10+0';
}

function removeFromAllQueuesByToken(token) {
  if (!token) return;
  for (const queue of waitingQueues.values()) {
    const index = queue.findIndex(item => item.token === token);
    if (index !== -1) queue.splice(index, 1);
  }
}

function removeFromAllQueuesBySocket(socketId) {
  for (const queue of waitingQueues.values()) {
    const index = queue.findIndex(item => item.socketId === socketId);
    if (index !== -1) queue.splice(index, 1);
  }
}

function activeSocket(socketId) {
  return Boolean(io.sockets.sockets.get(socketId));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function keyOf(r, c) {
  return `${r},${c}`;
}

function parseKey(key) {
  const [r, c] = key.split(',').map(Number);
  return [r, c];
}

function inBounds(r, c) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS;
}

function centerScore(r, c) {
  const cr = (ROWS - 1) / 2;
  const cc = (COLS - 1) / 2;
  const dist = Math.hypot(r - cr, c - cc);
  const maxDist = Math.hypot(cr, cc);
  return 1 - Math.min(dist / maxDist, 1);
}

function getNeighborCoords(r, c) {
  // Includes side, vertical and diagonal contact to preserve the original brick-wall feel.
  const directions = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [1, -1], [-1, 1], [1, 1]
  ];
  return directions
    .map(([dr, dc]) => [r + dr, c + dc])
    .filter(([nr, nc]) => inBounds(nr, nc));
}

function makeWall() {
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(0));

  const centerRow = Math.floor(ROWS / 2);

  // Width of active bricks per row.
  // This creates a filled wall shape: narrow top/bottom, wide middle.
  const rowWidths = [
    2,
    3,
    4,
    5,
    6,
    6,
    5,
    4,
    3,
    2
  ];

  for (let r = 0; r < ROWS; r++) {
    const width = rowWidths[r];

    // Slight random shift, but keep each row continuous.
    let start = Math.floor((COLS - width) / 2);

    if (width < COLS) {
      const shift = randomInt(-1, 1);
      start = Math.max(0, Math.min(COLS - width, start + shift));
    }

    for (let c = start; c < start + width; c++) {
      grid[r][c] = 1;
    }
  }

  return grid;
}

function createGridValues(wall) {
  return wall.map(row => row.map(cell => (cell === 1 ? null : undefined)));
}

function getRuleTriplesForCell(i, j) {
  if (i % 2 === 1) {
    return [
      [[i - 1, j], [i - 1, j + 1], [i, j]],
      [[i, j], [i, j + 1], [i + 1, j + 1]],
      [[i, j], [i, j - 1], [i - 1, j]],
      [[i, j], [i, j + 1], [i - 1, j + 1]],
      [[i, j], [i, j - 1], [i + 1, j]],
      [[i + 1, j], [i + 1, j + 1], [i, j]]
    ];
  }

  return [
    [[i - 1, j], [i - 1, j - 1], [i, j]],
    [[i, j], [i, j + 1], [i + 1, j]],
    [[i, j], [i, j - 1], [i + 1, j - 1]],
    [[i, j], [i, j + 1], [i - 1, j]],
    [[i, j], [i, j - 1], [i - 1, j - 1]],
    [[i + 1, j], [i + 1, j - 1], [i, j]]
  ];
}

function getCellValue(gridVals, r, c) {
  if (!inBounds(r, c)) return undefined;
  return gridVals[r][c];
}

function evaluateMove(gridVals, row, col) {
  const invalidRules = [];

  for (const triple of getRuleTriplesForCell(row, col)) {
    const [aCell, bCell, sumCell] = triple;
    const a = getCellValue(gridVals, aCell[0], aCell[1]);
    const b = getCellValue(gridVals, bCell[0], bCell[1]);
    const sum = getCellValue(gridVals, sumCell[0], sumCell[1]);

    if (a !== null && a !== undefined && b !== null && b !== undefined && sum !== null && sum !== undefined) {
      if (a + b !== sum) {
        invalidRules.push({
          cells: [aCell, bCell, sumCell].map(([r, c]) => ({ row: r, col: c })),
          expression: `${a} + ${b} ≠ ${sum}`,
          expected: a + b,
          actual: sum
        });
      }
    }
  }

  return { valid: invalidRules.length === 0, invalidRules };
}

function allActiveCellsFilled(game) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (game.wall[r][c] === 1 && game.gridVals[r][c] === null) return false;
    }
  }
  return true;
}

function publicGameState(game, playerIndex = null) {
  return {
    gameId: game.id,
    timeControl: game.timeControl,
    rows: ROWS,
    cols: COLS,
    wall: game.wall,
    gridVals: game.gridVals,
    currentPlayerIndex: game.currentPlayerIndex,
    timers: game.timers,
    status: game.status,
    playerIndex,
    players: game.players.map((player, index) => ({
      index,
      name: player.name,
      connected: player.connected
    }))
  };
}

function emitTimers(game) {
  io.to(game.id).emit('timer-update', {
    gameId: game.id,
    timers: game.timers,
    currentPlayerIndex: game.currentPlayerIndex
  });
}

function clearGameTimer(game) {
  if (game.interval) clearInterval(game.interval);
  game.interval = null;
}

function startGameTimer(game) {
  clearGameTimer(game);
  game.lastTick = Date.now();

  game.interval = setInterval(() => {
    if (game.status !== 'playing') return;

    const now = Date.now();
    const delta = now - game.lastTick;
    game.lastTick = now;

    const playerIndex = game.currentPlayerIndex;
    game.timers[playerIndex] = Math.max(0, game.timers[playerIndex] - delta);
    emitTimers(game);

    if (game.timers[playerIndex] <= 0) {
      endGame(game, {
        reason: 'timeout',
        loserIndex: playerIndex,
        winnerIndex: playerIndex === 0 ? 1 : 0,
        message: `${game.players[playerIndex].name} ran out of time.`
      });
    }
  }, TIMER_TICK_MS);
}

function joinPlayerSocketToGame(socket, game, playerIndex) {
  const player = game.players[playerIndex];
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }

  player.socketId = socket.id;
  player.connected = true;
  socket.join(game.id);
  socketToGame.set(socket.id, game.id);
  socketToToken.set(socket.id, player.token);
  tokenToGame.set(player.token, { gameId: game.id, playerIndex });
}

function createGame(playerA, playerB, timeControl) {
  const gameId = makeId('game');
  const maxTime = TIME_CONTROLS[timeControl];
  const wall = makeWall();

  const game = {
    id: gameId,
    timeControl,
    wall,
    gridVals: createGridValues(wall),
    currentPlayerIndex: Math.random() < 0.5 ? 0 : 1,
    timers: [maxTime, maxTime],
    status: 'playing',
    lastTick: Date.now(),
    interval: null,
    players: [
      {
        socketId: playerA.socketId,
        token: playerA.token,
        name: safeName(playerA.name, 'Player 1'),
        connected: true,
        disconnectTimer: null
      },
      {
        socketId: playerB.socketId,
        token: playerB.token,
        name: safeName(playerB.name, 'Player 2'),
        connected: true,
        disconnectTimer: null
      }
    ]
  };

  games.set(gameId, game);

  for (let index = 0; index < game.players.length; index++) {
    const player = game.players[index];
    const socket = io.sockets.sockets.get(player.socketId);
    if (!socket) continue;
    joinPlayerSocketToGame(socket, game, index);
    socket.emit('game-start', publicGameState(game, index));
  }

  startGameTimer(game);
  emitTimers(game);
  return game;
}

function endGame(game, result) {
  if (!game || game.status === 'over') return;

  game.status = 'over';
  clearGameTimer(game);

  const payload = {
    gameId: game.id,
    reason: result.reason,
    winnerIndex: result.winnerIndex ?? null,
    loserIndex: result.loserIndex ?? null,
    invalidRules: result.invalidRules || [],
    message: result.message || 'Game over.'
  };

  io.to(game.id).emit('game-over', payload);

  // Keep finished games for a short period so the browser can display the final state.
  setTimeout(() => cleanupGame(game.id), 60_000).unref?.();
}

function cleanupGame(gameId) {
  const game = games.get(gameId);
  if (!game) return;

  clearGameTimer(game);

  for (const player of game.players) {
    const tokenMapping = tokenToGame.get(player.token);
    if (tokenMapping?.gameId === gameId) {
      tokenToGame.delete(player.token);
    }

    if (player.socketId && socketToGame.get(player.socketId) === gameId) {
      socketToGame.delete(player.socketId);
      socketToToken.delete(player.socketId);
    }
  }

  games.delete(gameId);
}

function validateMovePayload(game, row, col, value) {
  if (game.status !== 'playing') return 'The game is already over.';
  if (!Number.isInteger(row) || !Number.isInteger(col) || !Number.isInteger(value)) return 'Invalid move payload.';
  if (!inBounds(row, col)) return 'Selected brick is outside the board.';
  if (value < 0 || value > 9) return 'Value must be between 0 and 9.';
  if (game.wall[row][col] !== 1) return 'Selected cell is not an active brick.';
  if (game.gridVals[row][col] !== null) return 'This brick is already filled.';
  return null;
}

function handleJoinMatch(socket, payload = {}) {
  const token = typeof payload.token === 'string' && payload.token.trim() ? payload.token.trim().slice(0, 80) : makeId('token');
  const name = safeName(payload.name, 'Player');
  const timeControl = normalizeTimeControl(payload.timeControl);

  socketToToken.set(socket.id, token);
  removeFromAllQueuesByToken(token);
  removeFromAllQueuesBySocket(socket.id);

  const existing = tokenToGame.get(token);
  if (existing) {
    const game = games.get(existing.gameId);
    if (game && game.status !== 'over') {
      joinPlayerSocketToGame(socket, game, existing.playerIndex);
      socket.emit('game-state', publicGameState(game, existing.playerIndex));
      socket.to(game.id).emit('player-reconnected', {
        gameId: game.id,
        playerIndex: existing.playerIndex,
        name: game.players[existing.playerIndex].name
      });
      emitTimers(game);
      return;
    }
  }

  const queue = waitingQueues.get(timeControl);

  while (queue.length > 0) {
    const opponent = queue.shift();
    if (!opponent || opponent.token === token || !activeSocket(opponent.socketId)) continue;

    createGame(opponent, { socketId: socket.id, token, name }, timeControl);
    return;
  }

  queue.push({ socketId: socket.id, token, name, joinedAt: Date.now() });
  socket.emit('queue-status', {
    timeControl,
    position: queue.length,
    message: `Waiting for another ${timeControl} player...`
  });
}

function handleCancelQueue(socket) {
  removeFromAllQueuesBySocket(socket.id);
  socket.emit('queue-cancelled');
}

function getGameAndPlayer(socket) {
  const token = socketToToken.get(socket.id);
  const existing = token ? tokenToGame.get(token) : null;
  const gameId = socketToGame.get(socket.id) || existing?.gameId;
  const game = gameId ? games.get(gameId) : null;
  if (!game) return { game: null, playerIndex: -1 };

  const playerIndex = game.players.findIndex(player => player.socketId === socket.id || player.token === token);
  return { game, playerIndex };
}

function handleMakeMove(socket, payload = {}) {
  const { game, playerIndex } = getGameAndPlayer(socket);
  if (!game || playerIndex === -1) {
    socket.emit('move-rejected', { message: 'You are not in an active game.' });
    return;
  }

  if (playerIndex !== game.currentPlayerIndex) {
    socket.emit('move-rejected', { message: 'It is not your turn.' });
    return;
  }

  const row = Number(payload.row);
  const col = Number(payload.col);
  const value = Number(payload.value);
  const error = validateMovePayload(game, row, col, value);
  if (error) {
    socket.emit('move-rejected', { message: error });
    return;
  }

  game.gridVals[row][col] = value;

  io.to(game.id).emit('move-made', {
    gameId: game.id,
    row,
    col,
    value,
    playerIndex
  });

  const evaluation = evaluateMove(game.gridVals, row, col);
  if (!evaluation.valid) {
    endGame(game, {
      reason: 'invalid-move',
      loserIndex: playerIndex,
      winnerIndex: playerIndex === 0 ? 1 : 0,
      invalidRules: evaluation.invalidRules,
      message: `Invalid equation: ${evaluation.invalidRules[0].expression}`
    });
    return;
  }

  if (allActiveCellsFilled(game)) {
    endGame(game, {
      reason: 'draw',
      loserIndex: null,
      winnerIndex: null,
      message: 'All bricks were filled. The game is a draw.'
    });
    return;
  }

  game.currentPlayerIndex = playerIndex === 0 ? 1 : 0;
  game.lastTick = Date.now();

  io.to(game.id).emit('turn-changed', {
    gameId: game.id,
    currentPlayerIndex: game.currentPlayerIndex
  });
  emitTimers(game);
}

function handleChatMessage(socket, payload = {}) {
  const { game, playerIndex } = getGameAndPlayer(socket);
  if (!game || playerIndex === -1) return;

  const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 300) : '';
  if (!text) return;

  io.to(game.id).emit('chat-message', {
    gameId: game.id,
    playerIndex,
    name: game.players[playerIndex].name,
    text
  });
}

function handleRequestState(socket) {
  const { game, playerIndex } = getGameAndPlayer(socket);
  if (!game || playerIndex === -1) {
    socket.emit('no-active-game');
    return;
  }
  socket.emit('game-state', publicGameState(game, playerIndex));
  emitTimers(game);
}

function handleDisconnect(socket) {
  const socketId = socket.id;
  const token = socketToToken.get(socketId);
  removeFromAllQueuesBySocket(socketId);

  const { game, playerIndex } = getGameAndPlayer(socket);

  socketToGame.delete(socketId);
  socketToToken.delete(socketId);

  if (!game || playerIndex === -1 || game.status === 'over') return;

  const player = game.players[playerIndex];
  if (player.socketId === socketId) player.socketId = null;
  player.connected = false;

  socket.to(game.id).emit('player-disconnected', {
    gameId: game.id,
    playerIndex,
    name: player.name,
    graceMs: RECONNECT_GRACE_MS
  });

  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectTimer = setTimeout(() => {
    const latest = games.get(game.id);
    if (!latest || latest.status !== 'playing') return;
    const stillDisconnected = !latest.players[playerIndex].connected;
    if (!stillDisconnected) return;

    endGame(latest, {
      reason: 'disconnect',
      loserIndex: playerIndex,
      winnerIndex: playerIndex === 0 ? 1 : 0,
      message: `${latest.players[playerIndex].name} disconnected.`
    });
  }, RECONNECT_GRACE_MS);

  if (typeof player.disconnectTimer.unref === 'function') player.disconnectTimer.unref();

  // Keep token mapping during grace period to allow reconnect.
  if (token) tokenToGame.set(token, { gameId: game.id, playerIndex });
}

io.on('connection', socket => {
  socket.emit('server-ready', {
    socketId: socket.id,
    timeControls: Object.keys(TIME_CONTROLS),
    defaultTimeControl: '10+0'
  });

  socket.on('join-match', payload => handleJoinMatch(socket, payload));
  socket.on('cancel-queue', () => handleCancelQueue(socket));
  socket.on('make-move', payload => handleMakeMove(socket, payload));
  socket.on('chat-message', payload => handleChatMessage(socket, payload));
  socket.on('request-state', () => handleRequestState(socket));
  socket.on('disconnect', () => handleDisconnect(socket));
});

server.listen(PORT, () => {
  console.log(`Battle Brick server running at http://localhost:${PORT}`);
  console.log('Open two browser tabs to test a local 1v1 game.');
});
