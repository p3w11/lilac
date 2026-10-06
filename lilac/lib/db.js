/* ---------- админка ---------- */

/** Все пользователи со статистикой: сколько сообщений и когда последнее. */
function adminUsers() {
  const stats = new Map();
  for (const u of state.users) stats.set(u.id, { messages: 0, lastMessageAt: 0 });
  for (const m of state.messages) {
    const s = stats.get(m.userId);
    if (!s) continue;
    s.messages += 1;
    if (m.ts > s.lastMessageAt) s.lastMessageAt = m.ts;
  }
  return state.users
    .map((u) => ({
      ...publicUser(u),
      createdAt: u.createdAt,
      messages: stats.get(u.id).messages,
      lastMessageAt: stats.get(u.id).lastMessageAt,
    }))
    .sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
}

/** Удаляет пользователя вместе со всеми его сообщениями. */
function deleteUser(id) {
  const idx = state.users.findIndex((u) => u.id === id);
  if (idx < 0) return false;
  state.users.splice(idx, 1);
  state.messages = state.messages.filter((m) => m.userId !== id);
  save();
  return true;
}

function deleteMessage(id) {
  const idx = state.messages.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  state.messages.splice(idx, 1);
  save();
  return true;
}

/** Очищает комнату, либо весь чат, если комната не указана. */
function clearMessages(room) {
  const before = state.messages.length;
  state.messages = room ? state.messages.filter((m) => m.room !== room) : [];
  save();
  return before - state.messages.length;
}

/** Последние сообщения из всех комнат. */
function recentMessages(limit = 60) {
  return state.messages.slice(-limit).reverse();
}

/** Всего сообщений во всех чатах. */
function messageCount() {
  return state.messages.length;
}

module.exports = {
  DATA_DIR,
  findUserByUsername,
  getUserById,
  addUser,
  publicUser,
  dmRoom,
  parseDmRoom,
  addMessage,
  getMessages,
  lastMessageIn,
  dmRooms,
  listUsers,
  adminUsers,
  deleteUser,
  deleteMessage,
  clearMessages,
  recentMessages,
  messageCount,
};
