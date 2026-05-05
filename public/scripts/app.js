'use strict';

const socket = io();

const ROWS = 10;
const COLS = 6;
const BRICK_WIDTH = 66;
const BRICK_HEIGHT = 36;
const GAP = 7;

const screens = {
  home: document.getElementById('home-screen'),
  queue: document.getElementById('queue-screen'),
  game: document.getElementById('game-screen')
};

const els = {
  playerName: document.getElementById('player-name'),
  timeButtons: Array.from(document.querySelectorAll('.time-button')),
  startButton: document.getElementById('start-button'),
  cancelButton: document.getElementById('cancel-button'),
  queueMessage: document.getElementById('queue-message'),
  board: document.getElementById('board'),
  numberPanel: document.getElementById('number-panel'),
  connectionStatus: document.getElementById('connection-status'),
  gameSubtitle: document.getElementById('game-subtitle'),
  selfName: document.getElementById('self-name'),
  opponentName: document.getElementById('opponent-name'),
  selfTimer: document.getElementById('self-timer'),
  opponentTimer: document.getElementById('opponent-timer'),
  selfCard: document.getElementById('player-self-card'),
  opponentCard: document.getElementById('player-opponent-card'),
  turnStatus: document.getElementById('turn-status'),
  resultMessage: document.getElementById('result-message'),
  infoBox: document.getElementById('info-box'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  messages: document.getElementById('messages'),
  newGameButton: document.getElementById('new-game-button'),
  drawButton: document.getElementById('draw-button'),
  resignButton: document.getElementById('resign-button'),

  drawOfferPanel: document.getElementById('draw-offer-panel'),
  drawOfferText: document.getElementById('draw-offer-text'),
  acceptDrawButton: document.getElementById('accept-draw-button'),
  declineDrawButton: document.getElementById('decline-draw-button'),

  resignPanel: document.getElementById('resign-panel'),
  confirmResignButton: document.getElementById('confirm-resign-button'),
  cancelResignButton: document.getElementById('cancel-resign-button')
};

let selectedTimeControl = localStorage.getItem('battleBrickTimeControl') || '10+0';
let playerToken = sessionStorage.getItem('battleBrickPlayerToken');
let selectedBrick = null;
let game = null;
let myIndex = null;
let isGameOver = false;
let pendingDrawOffer = null;

if (!playerToken) {
  playerToken = createClientId();
  sessionStorage.setItem('battleBrickPlayerToken', playerToken);
}

const savedName = localStorage.getItem('battleBrickPlayerName');
if (savedName) els.playerName.value = savedName;

selectTimeControl(selectedTimeControl);
renderNumberPanel();
showScreen('home');

function createClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function showScreen(name) {
  for (const screen of Object.values(screens)) screen.classList.remove('active');
  screens[name].classList.add('active');
}

function selectTimeControl(value) {
  selectedTimeControl = value;
  localStorage.setItem('battleBrickTimeControl', value);
  for (const button of els.timeButtons) {
    button.classList.toggle('selected', button.dataset.time === value);
  }
}

function getPlayerName() {
  const value = els.playerName.value.trim().slice(0, 24);
  return value || 'Player';
}

function formatTime(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function isMyTurn() {
  return game && !isGameOver && game.currentPlayerIndex === myIndex;
}

function setInfo(message, type = 'neutral') {
  els.infoBox.textContent = message;
  els.infoBox.dataset.type = type;
}

function updateConnection(text, type = 'neutral') {
  els.connectionStatus.textContent = text;
  els.connectionStatus.dataset.type = type;
}

function updateTurnStatus() {
  if (!game) return;

  els.selfCard.classList.toggle('active-turn', game.currentPlayerIndex === myIndex && !isGameOver);
  els.opponentCard.classList.toggle('active-turn', game.currentPlayerIndex !== myIndex && !isGameOver);

  if (isGameOver) return;

  if (isMyTurn()) {
    els.turnStatus.textContent = 'Your turn';
    setInfo('Select an empty brick, then choose a digit.', 'success');
  } else {
    els.turnStatus.textContent = "Opponent's turn";
    setInfo('Waiting for opponent move.', 'neutral');
    clearSelectedBrick();
  }
}

function updateTimers(timers) {
  if (!game || !Array.isArray(timers)) return;
  game.timers = timers;

  const opponentIndex = myIndex === 0 ? 1 : 0;
  els.selfTimer.textContent = formatTime(timers[myIndex]);
  els.opponentTimer.textContent = formatTime(timers[opponentIndex]);
}

function renderBoard() {
  if (!game) return;

  els.board.innerHTML = '';
  selectedBrick = null;

  const boardWidth = COLS * (BRICK_WIDTH + GAP) + Math.floor((BRICK_WIDTH + GAP) / 2);
  const boardHeight = ROWS * (BRICK_HEIGHT + GAP);
  els.board.style.width = `${boardWidth}px`;
  els.board.style.height = `${boardHeight}px`;

  for (let r = 0; r < ROWS; r++) {
    const offset = r % 2 === 1 ? Math.floor((BRICK_WIDTH + GAP) / 2) : 0;

    for (let c = 0; c < COLS; c++) {
      if (game.wall[r][c] !== 1) continue;

      const brick = document.createElement('button');
      brick.type = 'button';
      brick.className = 'brick';
      brick.dataset.row = String(r);
      brick.dataset.col = String(c);
      brick.style.left = `${c * (BRICK_WIDTH + GAP) + offset}px`;
      brick.style.top = `${r * (BRICK_HEIGHT + GAP)}px`;

      const value = game.gridVals[r][c];
      if (value !== null && value !== undefined) {
        brick.textContent = String(value);
        brick.classList.add('filled');
      } else {
        brick.textContent = '';
      }

      brick.addEventListener('click', () => selectBrick(brick));
      els.board.appendChild(brick);
    }
  }
}

function renderNumberPanel() {
  els.numberPanel.innerHTML = '';

  for (let value = 0; value <= 9; value++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'number-button';
    button.textContent = String(value);
    button.addEventListener('click', () => submitNumber(value));
    els.numberPanel.appendChild(button);
  }
}

function selectBrick(brick) {
  if (!game || isGameOver) return;

  if (!isMyTurn()) {
    setInfo('It is not your turn.', 'warning');
    return;
  }

  const row = Number(brick.dataset.row);
  const col = Number(brick.dataset.col);
  if (game.gridVals[row][col] !== null) {
    setInfo('This brick is already filled.', 'warning');
    return;
  }

  clearSelectedBrick();
  selectedBrick = brick;
  brick.classList.add('selected');
  setInfo('Now choose a digit from 0 to 9.', 'success');
}

function clearSelectedBrick() {
  if (selectedBrick) selectedBrick.classList.remove('selected');
  selectedBrick = null;
}

function submitNumber(value) {
  if (!selectedBrick || !game || isGameOver) return;

  if (!isMyTurn()) {
    setInfo('It is not your turn.', 'warning');
    return;
  }

  const row = Number(selectedBrick.dataset.row);
  const col = Number(selectedBrick.dataset.col);

  socket.emit('make-move', {
    gameId: game.gameId,
    row,
    col,
    value
  });

  clearSelectedBrick();
}

function applyMove({ row, col, value }) {
  if (!game) return;

  game.gridVals[row][col] = value;
  const brick = getBrick(row, col);
  if (brick) {
    brick.textContent = String(value);
    brick.classList.add('filled');
    brick.classList.remove('selected');
  }
}

function getBrick(row, col) {
  return els.board.querySelector(`.brick[data-row="${row}"][data-col="${col}"]`);
}

function hydrateGame(payload) {
  game = payload;
  myIndex = payload.playerIndex;
  isGameOver = payload.status === 'over';
  els.newGameButton.style.display = isGameOver ? 'block' : 'none';

  const opponentIndex = myIndex === 0 ? 1 : 0;
  const self = payload.players[myIndex];
  const opponent = payload.players[opponentIndex];

  els.selfName.textContent = self?.name || 'You';
  els.opponentName.textContent = opponent?.name || 'Opponent';
  els.gameSubtitle.textContent = `${payload.timeControl} game`;
  els.resultMessage.textContent = '';
  els.messages.innerHTML = '';

  pendingDrawOffer = null;
  els.drawOfferPanel.classList.add('hidden');
  els.resignPanel.classList.add('hidden');
  els.drawButton.disabled = isGameOver;
  els.resignButton.disabled = isGameOver;

  renderBoard();
  updateTimers(payload.timers);
  updateTurnStatus();
  if (payload.drawOfferFrom !== null && payload.drawOfferFrom !== undefined && !isGameOver) {
    const fromIndex = payload.drawOfferFrom;
    const fromName = payload.players[fromIndex]?.name || 'Opponent';

    if (fromIndex === myIndex) {
      pendingDrawOffer = {
        gameId: payload.gameId,
        fromIndex,
        fromName
      };

      els.drawButton.disabled = true;
      setInfo('Draw offer sent. Waiting for opponent response.', 'warning');
    } else {
      pendingDrawOffer = {
        gameId: payload.gameId,
        fromIndex,
        fromName
      };

      els.drawOfferText.textContent = `${fromName} offered a draw.`;
      els.drawOfferPanel.classList.remove('hidden');
      setInfo(`${fromName} offered a draw.`, 'warning');
    }
  }
  updateConnection('Connected', 'success');
  showScreen('game');
}

function markInvalidRules(invalidRules = []) {
  const touched = new Set();

  for (const rule of invalidRules) {
    for (const cell of rule.cells || []) {
      touched.add(`${cell.row},${cell.col}`);
    }
  }

  for (const key of touched) {
    const [row, col] = key.split(',').map(Number);
    const brick = getBrick(row, col);
    if (brick) brick.classList.add('danger');
  }
}

function addMessage(text, sender = 'system') {
  const wrapper = document.createElement('div');
  wrapper.className = `message-row ${sender}`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  els.messages.appendChild(wrapper);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function startMatchmaking() {
  const name = getPlayerName();
  localStorage.setItem('battleBrickPlayerName', name);

  showScreen('queue');
  els.queueMessage.textContent = 'Connecting to matchmaking...';

  socket.emit('join-match', {
    token: playerToken,
    name,
    timeControl: selectedTimeControl
  });
}

function resetToHome() {
  game = null;
  myIndex = null;
  isGameOver = false;
  selectedBrick = null;
  socket.emit('cancel-queue');
  showScreen('home');
}

for (const button of els.timeButtons) {
  button.addEventListener('click', () => selectTimeControl(button.dataset.time));
}

els.startButton.addEventListener('click', startMatchmaking);
els.cancelButton.addEventListener('click', resetToHome);
els.newGameButton.addEventListener('click', () => {
  if (game && !isGameOver) return;
  startMatchmaking();
});

els.drawButton.addEventListener('click', () => {
  if (!game || isGameOver) return;

  socket.emit('offer-draw');
  els.drawButton.disabled = true;
  setInfo('Draw offer sent. Waiting for opponent response.', 'warning');
});

els.resignButton.addEventListener('click', () => {
  if (!game || isGameOver) return;

  els.resignPanel.classList.remove('hidden');
});

els.confirmResignButton.addEventListener('click', () => {
  if (!game || isGameOver) return;

  els.resignPanel.classList.add('hidden');
  socket.emit('resign');
});

els.cancelResignButton.addEventListener('click', () => {
  els.resignPanel.classList.add('hidden');
});

els.acceptDrawButton.addEventListener('click', () => {
  if (!pendingDrawOffer || !game || isGameOver) return;

  socket.emit('respond-draw', {
    accepted: true
  });

  pendingDrawOffer = null;
  els.drawOfferPanel.classList.add('hidden');
});

els.declineDrawButton.addEventListener('click', () => {
  if (!pendingDrawOffer || !game || isGameOver) return;

  socket.emit('respond-draw', {
    accepted: false
  });

  pendingDrawOffer = null;
  els.drawOfferPanel.classList.add('hidden');
});

els.chatForm.addEventListener('submit', event => {
  event.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text || !game || isGameOver) return;
  socket.emit('chat-message', { text });
  els.chatInput.value = '';
});

socket.on('connect', () => {
  updateConnection('Connected', 'success');

  const hasActiveGameScreen = screens.game.classList.contains('active') && game;
  if (hasActiveGameScreen) socket.emit('request-state');
});

socket.on('disconnect', () => {
  updateConnection('Disconnected', 'danger');
  if (game && !isGameOver) setInfo('Connection lost. Reconnecting...', 'warning');
});

socket.on('server-ready', payload => {
  if (payload?.timeControls?.includes(selectedTimeControl)) return;
  selectTimeControl(payload.defaultTimeControl || '10+0');
});

socket.on('queue-status', payload => {
  showScreen('queue');
  els.queueMessage.textContent = payload.message || 'Waiting for another player...';
});

socket.on('queue-cancelled', () => {
  showScreen('home');
});

socket.on('game-start', hydrateGame);
socket.on('game-state', hydrateGame);

socket.on('timer-update', payload => {
  if (!game || payload.gameId !== game.gameId) return;
  game.currentPlayerIndex = payload.currentPlayerIndex;
  updateTimers(payload.timers);
  updateTurnStatus();
});

socket.on('turn-changed', payload => {
  if (!game || payload.gameId !== game.gameId) return;
  game.currentPlayerIndex = payload.currentPlayerIndex;
  updateTurnStatus();
});

socket.on('move-made', payload => {
  if (!game || payload.gameId !== game.gameId) return;
  applyMove(payload);
});

socket.on('move-rejected', payload => {
  setInfo(payload.message || 'Move rejected.', 'danger');
});

socket.on('game-over', payload => {
  if (!game || payload.gameId !== game.gameId) return;

  isGameOver = true;

  clearSelectedBrick();
  markInvalidRules(payload.invalidRules || []);

  pendingDrawOffer = null;
  els.drawOfferPanel.classList.add('hidden');
  els.resignPanel.classList.add('hidden');

  let result = 'Game over';
  let infoType = 'neutral';

  if (payload.reason === 'draw') {
    result = 'Draw';
    infoType = 'warning';
  } else if (payload.winnerIndex === myIndex) {
    result = 'You won';
    infoType = 'success';
  } else if (payload.loserIndex === myIndex) {
    result = 'You lost';
    infoType = 'danger';
  }

  els.turnStatus.textContent = result;
  els.resultMessage.textContent = payload.message || '';

  setInfo(payload.message || 'Game over.', infoType);

  els.selfCard.classList.remove('active-turn');
  els.opponentCard.classList.remove('active-turn');

  els.drawButton.disabled = true;
  els.resignButton.disabled = true;
  els.newGameButton.style.display = 'block';
});

socket.on('draw-offered', payload => {
  if (!game || payload.gameId !== game.gameId || isGameOver) return;

  if (payload.fromIndex === myIndex) {
    addMessage('You offered a draw.', 'system');
    setInfo('Draw offer sent. Waiting for opponent.', 'warning');
    return;
  }

  pendingDrawOffer = payload;

  els.drawOfferText.textContent = `${payload.fromName} offered a draw.`;
  els.drawOfferPanel.classList.remove('hidden');

  addMessage(`${payload.fromName} offered a draw.`, 'system');
  setInfo(`${payload.fromName} offered a draw.`, 'warning');
});

socket.on('draw-declined', payload => {
  if (!game || payload.gameId !== game.gameId || isGameOver) return;

  pendingDrawOffer = null;
  els.drawOfferPanel.classList.add('hidden');
  els.drawButton.disabled = false;

  addMessage(payload.message || 'Draw offer declined.', 'system');
  setInfo(payload.message || 'Draw offer declined.', 'warning');
});

socket.on('draw-error', payload => {
  els.drawButton.disabled = false;
  setInfo(payload.message || 'Draw action failed.', 'danger');
});

socket.on('chat-message', payload => {
  if (!game || payload.gameId !== game.gameId) return;
  const sender = payload.playerIndex === myIndex ? 'self' : 'other';
  addMessage(`${payload.name}: ${payload.text}`, sender);
});

socket.on('player-disconnected', payload => {
  if (!game || payload.gameId !== game.gameId) return;
  addMessage(`${payload.name} disconnected. Waiting for reconnect...`, 'system');
  setInfo(`${payload.name} disconnected. They have ${Math.round(payload.graceMs / 1000)} seconds to reconnect.`, 'warning');
});

socket.on('player-reconnected', payload => {
  if (!game || payload.gameId !== game.gameId) return;
  addMessage(`${payload.name} reconnected.`, 'system');
  setInfo(`${payload.name} reconnected.`, 'success');
});

socket.on('no-active-game', () => {
  if (screens.game.classList.contains('active')) {
    setInfo('No active game found. Start a new game.', 'warning');
  }
});
