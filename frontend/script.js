/**
 * ==============================================================================
 * DRSSS AI - Pure ES6+ Client Application Logic
 * Authors: Shantanu, Diggaj, Raj, Suraj, and Sanika.
 * Target UI: dark conversational experience (DRSSS AI)
 * ==============================================================================
 */

// Model and Thinking Level Branded Name Mappings
const MODEL_NAMES = {
  'gemini-3.5-flash-lite': 'DRSSS 3.5 Flash Lite',
  'gemini-3.6-flash': 'DRSSS 3.6 Flash',
  'gemini-3.1-flash-lite': 'DRSSS 3.1 Flash Lite'
};

const THINKING_NAMES = {
  'medium': 'Standard',
  'high': 'Extended'
};

// Application State
const state = {
  currentUser: {
    id: 'guest',
    name: 'Guest User',
    email: '',
    picture: '',
    isAuthenticated: false
  },
  chats: [],
  currentChatId: null,
  isGenerating: false,
  pendingDeleteChatId: null,
  selectedModel: localStorage.getItem('drsss_selected_model') || 'gemini-3.5-flash-lite',
  thinkingLevel: localStorage.getItem('drsss_thinking_level') || 'medium',
  isSidebarCollapsed: localStorage.getItem('drsss_sidebar_collapsed') === 'true'
};

// DOM Element Selectors
const DOM = {
  appLayout: document.getElementById('appLayout'),
  sidebar: document.getElementById('sidebar'),
  sidebarOverlay: document.getElementById('sidebarOverlay'),
  sidebarCollapseBtn: document.getElementById('sidebarCollapseBtn'),
  sidebarCloseBtn: document.getElementById('sidebarCloseBtn'),
  sidebarExpandBtn: document.getElementById('sidebarExpandBtn'),
  newChatBtn: document.getElementById('newChatBtn'),
  threadSearchInput: document.getElementById('threadSearchInput'),
  clearSearchBtn: document.getElementById('clearSearchBtn'),
  threadsList: document.getElementById('threadsList'),
  noThreadsHint: document.getElementById('noThreadsHint'),
  activeThreadTitle: document.getElementById('activeThreadTitle'),
  // Model & Thinking Selectors
  modelSelectorDropdown: document.getElementById('modelSelectorDropdown'),
  modelSelectorBtn: document.getElementById('modelSelectorBtn'),
  currentModelLabel: document.getElementById('currentModelLabel'),
  modelDropdownMenu: document.getElementById('modelDropdownMenu'),
  thinkingSelectorDropdown: document.getElementById('thinkingSelectorDropdown'),
  thinkingSelectorBtn: document.getElementById('thinkingSelectorBtn'),
  currentThinkingLabel: document.getElementById('currentThinkingLabel'),
  thinkingDropdownMenu: document.getElementById('thinkingDropdownMenu'),
  // Status and Actions
  statusDot: document.getElementById('statusDot'),
  modelStatusText: document.getElementById('modelStatusText'),
  modelIndicator: document.getElementById('modelIndicator'),
  downloadZipBtn: document.getElementById('downloadZipBtn'),
  clearChatBtn: document.getElementById('clearChatBtn'),
  exportChatBtn: document.getElementById('exportChatBtn'),
  chatViewport: document.getElementById('chatViewport'),
  welcomeScreen: document.getElementById('welcomeScreen'),
  messagesList: document.getElementById('messagesList'),
  typingIndicator: document.getElementById('typingIndicator'),
  thinkingStatusText: document.getElementById('thinkingStatusText'),
  thinkingModelTag: document.getElementById('thinkingModelTag'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatInput'),
  sendBtn: document.getElementById('sendBtn'),
  charCount: document.getElementById('charCount'),
  promptCards: document.querySelectorAll('.prompt-card'),
  confirmModal: document.getElementById('confirmModal'),
  cancelModalBtn: document.getElementById('cancelModalBtn'),
  confirmDeleteBtn: document.getElementById('confirmDeleteBtn'),
  guestProfileGroup: document.getElementById('guestProfileGroup'),
  userProfileGroup: document.getElementById('userProfileGroup'),
  userAvatarInitial: document.getElementById('userAvatarInitial'),
  userNameText: document.getElementById('userNameText'),
  userEmailText: document.getElementById('userEmailText'),
  signInFallbackBtn: document.getElementById('signInFallbackBtn'),
  signOutBtn: document.getElementById('signOutBtn'),
  authModal: document.getElementById('authModal'),
  closeAuthModalBtn: document.getElementById('closeAuthModalBtn'),
  authModalTitle: document.getElementById('authModalTitle'),
  authSubtitle: document.getElementById('authSubtitle'),
  loginForm: document.getElementById('loginForm'),
  registerForm: document.getElementById('registerForm'),
  loginEmail: document.getElementById('loginEmail'),
  loginPassword: document.getElementById('loginPassword'),
  registerName: document.getElementById('registerName'),
  registerEmail: document.getElementById('registerEmail'),
  registerPassword: document.getElementById('registerPassword'),
  registerConfirmPassword: document.getElementById('registerConfirmPassword'),
  loginError: document.getElementById('loginError'),
  registerError: document.getElementById('registerError'),
  loginSubmitBtn: document.getElementById('loginSubmitBtn'),
  registerSubmitBtn: document.getElementById('registerSubmitBtn'),
  showRegisterBtn: document.getElementById('showRegisterBtn'),
  showLoginBtn: document.getElementById('showLoginBtn'),
  toastContainer: document.getElementById('toastContainer')
};

// Configure Marked.js options
if (window.marked) {
  marked.setOptions({
    gfm: true,
    breaks: true,
    mangle: false,
    headerIds: false
  });
}

/**
 * Initialize Application
 */
async function initApp() {
  await restoreAuthSession();
  loadUserChats();
  applyInitialSidebarState();
  initSelectorState();
  setupEventListeners();
  renderThreadsList();

  // Restore active chat if valid and present in state.chats
  const savedActiveId = sessionStorage.getItem('drsss_active_chat_id');
  if (savedActiveId && state.chats.some(c => c.id === savedActiveId)) {
    state.currentChatId = savedActiveId;
  } else if (state.chats.length > 0) {
    state.currentChatId = state.chats[0].id;
    sessionStorage.setItem('drsss_active_chat_id', state.currentChatId);
  } else {
    // Fresh session: no chat yet. Show clean welcome screen without phantom thread
    state.currentChatId = null;
    sessionStorage.removeItem('drsss_active_chat_id');
  }

  renderCurrentChat();

  // Load backend configurations & health check asynchronously
  await Promise.allSettled([checkBackendHealth()]);
}

/**
 * Initialize Model & Thinking Selector UI from stored preferences
 */
function initSelectorState() {
  // Validate model
  if (!MODEL_NAMES[state.selectedModel]) {
    state.selectedModel = 'gemini-3.5-flash-lite';
  }
  if (DOM.currentModelLabel) {
    DOM.currentModelLabel.textContent = MODEL_NAMES[state.selectedModel];
  }
  updateModelDropdownActiveItem(state.selectedModel);

  // Validate thinking level
  if (!THINKING_NAMES[state.thinkingLevel]) {
    state.thinkingLevel = 'medium';
  }
  if (DOM.currentThinkingLabel) {
    DOM.currentThinkingLabel.textContent = THINKING_NAMES[state.thinkingLevel];
  }
  updateThinkingDropdownActiveItem(state.thinkingLevel);
}

/**
 * Check backend health status from /api/health
 */
async function checkBackendHealth() {
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'ok') {
        if (DOM.statusDot) {
          DOM.statusDot.className = 'status-dot online';
        }
        if (DOM.modelStatusText) {
          DOM.modelStatusText.textContent = 'AI Engine';
        }
        if (DOM.modelIndicator) {
          DOM.modelIndicator.title = 'DRSSS AI Online - Dual-model automatic failover active';
        }
        return;
      }
    }
    throw new Error('Health check non-200');
  } catch (e) {
    if (DOM.statusDot) {
      DOM.statusDot.className = 'status-dot offline';
    }
    if (DOM.modelStatusText) {
      DOM.modelStatusText.textContent = 'Offline';
    }
    if (DOM.modelIndicator) {
      DOM.modelIndicator.title = 'DRSSS AI Backend unreachable';
    }
  }
}

/**
 * Apply stored desktop sidebar collapse state
 */
function applyInitialSidebarState() {
  if (window.innerWidth > 768 && state.isSidebarCollapsed) {
    if (DOM.sidebar) DOM.sidebar.classList.add('collapsed');
    if (DOM.appLayout) DOM.appLayout.classList.add('sidebar-collapsed');
  }
}

/** Restore authentication from the server-side HttpOnly session cookie. */
async function restoreAuthSession() {
  // Never trust a profile cached in localStorage as proof of authentication.
  // Keep all chat data keys intact so any earlier guest history remains available.
  localStorage.removeItem('drsss_current_user');
  state.currentUser = { id: 'guest', name: 'Guest User', email: '', picture: '', isAuthenticated: false };
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (response.ok) {
      const data = await response.json();
      if (data && data.user && data.user.id) {
        state.currentUser = {
          id: String(data.user.id),
          name: String(data.user.name || 'Account'),
          email: String(data.user.email || ''),
          picture: '',
          isAuthenticated: true
        };
      }
    }
  } catch (error) {
    // Guest mode stays usable when authentication service is unavailable.
    console.warn('Could not restore account session; continuing as guest.');
  }
  updateAuthUI();
}

/** Update the sidebar account area from the validated server session. */
function updateAuthUI() {
  const signedIn = Boolean(state.currentUser && state.currentUser.isAuthenticated);
  if (DOM.guestProfileGroup) DOM.guestProfileGroup.style.display = signedIn ? 'none' : 'flex';
  if (DOM.userProfileGroup) DOM.userProfileGroup.style.display = signedIn ? 'flex' : 'none';
  if (DOM.userAvatarInitial && signedIn) {
    DOM.userAvatarInitial.textContent = (state.currentUser.name || state.currentUser.email || 'A').trim().charAt(0).toUpperCase();
    DOM.userAvatarInitial.title = state.currentUser.name || state.currentUser.email;
  }
  if (DOM.userNameText) DOM.userNameText.textContent = signedIn ? (state.currentUser.name || 'Account') : '';
  if (DOM.userEmailText) DOM.userEmailText.textContent = signedIn ? (state.currentUser.email || 'Signed in') : '';
  if (DOM.signInFallbackBtn) DOM.signInFallbackBtn.style.display = signedIn ? 'none' : 'inline-flex';
  if (DOM.signOutBtn) DOM.signOutBtn.style.display = signedIn ? 'inline-flex' : 'none';
}

function setAuthView(view) {
  const isRegister = view === 'register';
  if (DOM.loginForm) DOM.loginForm.hidden = isRegister;
  if (DOM.registerForm) DOM.registerForm.hidden = !isRegister;
  if (DOM.authModalTitle) DOM.authModalTitle.textContent = isRegister ? 'Create your account' : 'Welcome back';
  if (DOM.authSubtitle) DOM.authSubtitle.textContent = isRegister
    ? 'Create an account to keep your chats organized.'
    : 'Sign in to your DRSSS AI account.';
  if (DOM.loginError) { DOM.loginError.hidden = true; DOM.loginError.textContent = ''; }
  if (DOM.registerError) { DOM.registerError.hidden = true; DOM.registerError.textContent = ''; }
  window.requestAnimationFrame(() => {
    const focusTarget = isRegister ? DOM.registerName : DOM.loginEmail;
    if (focusTarget) focusTarget.focus();
  });
}

function openAuthModal(view = 'login') {
  if (!DOM.authModal) {
    showToast('Sign-in form could not be opened. Please refresh the page.', 'error');
    return;
  }
  setAuthView(view);
  if (!DOM.authModal.open) DOM.authModal.showModal();
}

function closeAuthModal() {
  if (DOM.authModal && DOM.authModal.open) DOM.authModal.close();
}

function showAuthError(view, message) {
  const errorNode = view === 'register' ? DOM.registerError : DOM.loginError;
  if (errorNode) {
    errorNode.textContent = message;
    errorNode.hidden = false;
  }
}

function setAuthSubmitting(view, isSubmitting) {
  const button = view === 'register' ? DOM.registerSubmitBtn : DOM.loginSubmitBtn;
  if (!button) return;
  if (isSubmitting) {
    button.dataset.originalText = button.textContent || '';
    button.textContent = view === 'register' ? 'Creating account…' : 'Signing in…';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.textContent = button.dataset.originalText || (view === 'register' ? 'Create Account' : 'Sign In');
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function submitAuthentication(view, body) {
  setAuthSubmitting(view, true);
  const errorNode = view === 'register' ? DOM.registerError : DOM.loginError;
  if (errorNode) { errorNode.hidden = true; errorNode.textContent = ''; }
  try {
    const response = await fetch(`/api/auth/${view}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    let data = {};
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    if (!data.user || !data.user.id) throw new Error('The server returned an invalid account response.');

    state.currentUser = {
      id: String(data.user.id),
      name: String(data.user.name || 'Account'),
      email: String(data.user.email || ''),
      picture: '',
      isAuthenticated: true
    };
    localStorage.removeItem('drsss_current_user');
    updateAuthUI();
    closeAuthModal();

    // Switch to this account's chat namespace without deleting guest history.
    loadUserChats();
    state.currentChatId = state.chats.length > 0 ? state.chats[0].id : null;
    if (state.currentChatId) sessionStorage.setItem('drsss_active_chat_id', state.currentChatId);
    else sessionStorage.removeItem('drsss_active_chat_id');
    renderThreadsList();
    renderCurrentChat();
    showToast(view === 'register' ? `Account created. Welcome, ${state.currentUser.name}!` : `Signed in as ${state.currentUser.name}.`, 'success');
  } catch (error) {
    showAuthError(view, error && error.message ? error.message : 'Unable to complete authentication. Please try again.');
  } finally {
    setAuthSubmitting(view, false);
  }
}

async function signOut() {
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error('The server could not end your session.');
  } catch (error) {
    showToast('Could not sign out from the server. Please try again.', 'error');
    return;
  }
  state.currentUser = { id: 'guest', name: 'Guest User', email: '', picture: '', isAuthenticated: false };
  updateAuthUI();
  loadUserChats();
  state.currentChatId = state.chats.length > 0 ? state.chats[0].id : null;
  if (state.currentChatId) sessionStorage.setItem('drsss_active_chat_id', state.currentChatId);
  else sessionStorage.removeItem('drsss_active_chat_id');
  renderThreadsList();
  renderCurrentChat();
  showToast('Signed out. Your guest chats are still saved locally.', 'info');
}

/**
 * Multi-Session Storage Management per User Account
 */
function getStorageKey() {
  return `drsss_chats_${state.currentUser.id || 'guest'}`;
}

function loadUserChats() {
  const data = localStorage.getItem(getStorageKey());
  if (data) {
    try {
      const parsed = JSON.parse(data);
      // Strictly prune any empty conversations (0 messages) to avoid duplicate phantom threads
      state.chats = Array.isArray(parsed)
        ? parsed.filter(c => Array.isArray(c.messages) && c.messages.length > 0)
        : [];
    } catch (e) {
      state.chats = [];
    }
  } else {
    state.chats = [];
  }
  saveUserChats();
}

function saveUserChats() {
  localStorage.setItem(getStorageKey(), JSON.stringify(state.chats));
}

/**
 * Start a New Conversation Draft
 * Never creates an empty duplicate item in the sidebar list until user sends first message.
 */
function createNewChat(focusInput = true) {
  if (state.isGenerating) return;

  // If already on a blank new chat screen, simply clear input and focus
  if (state.currentChatId === null) {
    renderCurrentChat();
    closeMobileSidebar();
    if (focusInput) DOM.chatInput.focus();
    return;
  }

  // Switch to draft state
  state.currentChatId = null;
  sessionStorage.removeItem('drsss_active_chat_id');
  renderThreadsList();
  renderCurrentChat();
  closeMobileSidebar();
  if (focusInput) DOM.chatInput.focus();
}

/**
 * Switch Active Conversation
 */
function switchChat(chatId) {
  if (state.isGenerating) return;
  const target = state.chats.find(c => c.id === chatId);
  if (!target) return;

  state.currentChatId = chatId;
  sessionStorage.setItem('drsss_active_chat_id', chatId);
  renderThreadsList();
  renderCurrentChat();
  closeMobileSidebar();
}

/**
 * Delete Conversation Modal Trigger
 */
function confirmDeleteChat(chatId) {
  state.pendingDeleteChatId = chatId;
  if (DOM.confirmModal) {
    DOM.confirmModal.showModal();
  }
}

function deleteChat(chatId) {
  state.chats = state.chats.filter(c => c.id !== chatId);
  saveUserChats();

  if (state.currentChatId === chatId) {
    if (state.chats.length > 0) {
      state.currentChatId = state.chats[0].id;
      sessionStorage.setItem('drsss_active_chat_id', state.currentChatId);
    } else {
      state.currentChatId = null;
      sessionStorage.removeItem('drsss_active_chat_id');
    }
  }

  renderThreadsList();
  renderCurrentChat();
  showToast('Conversation deleted', 'info');
}

/**
 * Render Sidebar Recent Conversations List
 */
function renderThreadsList(filterQuery = '') {
  DOM.threadsList.innerHTML = '';

  const query = filterQuery.toLowerCase().trim();
  const filtered = query
    ? state.chats.filter(c => c.title.toLowerCase().includes(query) || (c.messages && c.messages.some(m => m.content.toLowerCase().includes(query))))
    : state.chats;

  if (filtered.length === 0) {
    DOM.noThreadsHint.style.display = 'block';
    return;
  }

  DOM.noThreadsHint.style.display = 'none';

  filtered.forEach(chat => {
    const li = document.createElement('li');
    li.className = `thread-item ${chat.id === state.currentChatId ? 'active' : ''}`;
    li.setAttribute('data-id', chat.id);

    li.innerHTML = `
      <div class="thread-info">
        <i class="fa-regular fa-message thread-icon"></i>
        <span class="thread-title-text">${escapeHtml(chat.title)}</span>
      </div>
      <button class="thread-delete-btn" aria-label="Delete chat" title="Delete conversation">
        <i class="fa-regular fa-trash-can"></i>
      </button>
    `;

    // Click on thread row switches conversation
    li.addEventListener('click', (e) => {
      if (e.target.closest('.thread-delete-btn')) return;
      switchChat(chat.id);
    });

    // Delete button click
    const deleteBtn = li.querySelector('.thread-delete-btn');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDeleteChat(chat.id);
    });

    DOM.threadsList.appendChild(li);
  });
}

/**
 * Render Current Conversation in Main Canvas
 */
function renderCurrentChat() {
  const currentChat = state.chats.find(c => c.id === state.currentChatId);

  if (!state.isGenerating) {
    stopThinkingStatus();
  }

  if (!currentChat || currentChat.messages.length === 0) {
    DOM.activeThreadTitle.textContent = 'DRSSS AI';
    DOM.welcomeScreen.style.display = 'flex';
    DOM.messagesList.style.display = 'none';
    DOM.messagesList.innerHTML = '';
    return;
  }

  DOM.activeThreadTitle.textContent = currentChat.title;
  DOM.messagesList.innerHTML = '';
  DOM.welcomeScreen.style.display = 'none';
  DOM.messagesList.style.display = 'flex';

  currentChat.messages.forEach(msg => {
    appendMessageToDOM(msg, false);
  });

  scrollToBottom();
}

/**
 * Append Message to DOM with Authentic DRSSS Gemini Dark Layout
 */
function appendMessageToDOM(msg, shouldScroll = true) {
  const isUser = msg.role === 'user';
  const row = document.createElement('div');
  row.className = `message-row ${isUser ? 'user-row' : 'assistant-row'}`;

  if (isUser) {
    row.innerHTML = `
      <div class="user-bubble">
        ${escapeHtml(msg.content).replace(/\n/g, '<br>')}
      </div>
    `;
  } else {
    // Assistant Response
    const renderedHtml = renderMarkdownWithCodeBlocks(msg.content);
    const modelDisplayName = MODEL_NAMES[msg.model_used] || 'DRSSS AI';
    const isExtendedThinking = msg.thinking_level === 'high';

    // Fallback notice banner shown only when fallback was actually triggered
    let fallbackBannerHtml = '';
    if (msg.fallback_used) {
      fallbackBannerHtml = `
        <div class="fallback-notice-banner" role="status">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <span>DRSSS switched to 3.1 Flash Lite to complete your response.</span>
        </div>
      `;
    }

    const thinkingBadgeHtml = isExtendedThinking
      ? `<span class="thinking-badge" title="Extended reasoning">Extended</span>`
      : '';

    row.innerHTML = `
      <div class="assistant-sparkle" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="avatar-sparkle">
          <path d="M12 2C12.5 7.5 16.5 11.5 22 12C16.5 12.5 12.5 16.5 12 22C11.5 16.5 7.5 12.5 2 12C7.5 11.5 11.5 7.5 12 2Z" fill="url(#sparkleGrad)"/>
          <defs>
            <linearGradient id="sparkleGrad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
              <stop stop-color="#8ab4f8"/>
              <stop offset="1" stop-color="#c58af9"/>
            </linearGradient>
          </defs>
        </svg>
      </div>
      <div class="assistant-content-wrapper">
        <div class="assistant-meta">
          <span class="assistant-name">DRSSS AI</span>
          <span class="model-badge">${escapeHtml(modelDisplayName)}</span>
          ${thinkingBadgeHtml}
        </div>
        ${fallbackBannerHtml}
        <div class="assistant-content">
          ${renderedHtml}
        </div>
        <div class="message-actions-bar">
          <button class="msg-action-btn copy-msg-btn" aria-label="Copy response" title="Copy response">
            <i class="fa-regular fa-copy"></i>
          </button>
          <button class="msg-action-btn regen-msg-btn" aria-label="Regenerate response" title="Regenerate response">
            <i class="fa-solid fa-rotate-right"></i>
          </button>
        </div>
      </div>
    `;

    // Attach code copy buttons
    attachCodeCopyHandlers(row);

    // Attach response copy button
    const copyMsgBtn = row.querySelector('.copy-msg-btn');
    if (copyMsgBtn) {
      copyMsgBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(msg.content);
          copyMsgBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
          copyMsgBtn.style.color = '#34a853';
          setTimeout(() => {
            copyMsgBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
            copyMsgBtn.style.color = '';
          }, 2000);
        } catch (e) {
          showToast('Failed to copy text', 'error');
        }
      });
    }

    // Attach regenerate button
    const regenBtn = row.querySelector('.regen-msg-btn');
    if (regenBtn) {
      regenBtn.addEventListener('click', () => {
        regenerateLastResponse();
      });
    }
  }

  DOM.messagesList.appendChild(row);

  if (shouldScroll) {
    scrollToBottom();
  }
}

/**
 * Render Markdown and Format Code Blocks with DOMPurify Sanitization
 */
function renderMarkdownWithCodeBlocks(markdownText) {
  if (!window.marked) {
    return escapeHtml(markdownText).replace(/\n/g, '<br>');
  }

  const rawHtml = marked.parse(markdownText);
  const cleanHtml = window.DOMPurify ? DOMPurify.sanitize(rawHtml) : rawHtml;

  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = cleanHtml;

  // Process <pre><code> blocks for header & copy action
  const preElements = tempDiv.querySelectorAll('pre');
  preElements.forEach((pre) => {
    const code = pre.querySelector('code');
    if (!code) return;

    let language = 'text';
    const classes = code.className.split(' ');
    for (const c of classes) {
      if (c.startsWith('language-')) {
        language = c.replace('language-', '');
        break;
      }
    }

    if (window.hljs) {
      try {
        if (language !== 'text' && hljs.getLanguage(language)) {
          code.innerHTML = hljs.highlight(code.textContent, { language }).value;
        } else {
          code.innerHTML = hljs.highlightAuto(code.textContent).value;
        }
      } catch (e) {
        // Fallback to unhighlighted code
      }
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    const header = document.createElement('div');
    header.className = 'code-header';
    header.innerHTML = `
      <span class="code-lang">${escapeHtml(language)}</span>
      <button class="copy-code-btn" type="button" aria-label="Copy code">
        <i class="fa-regular fa-copy"></i>
        <span>Copy code</span>
      </button>
    `;

    wrapper.appendChild(header);
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);
  });

  return tempDiv.innerHTML;
}

/**
 * Attach Code Copy Event Handlers
 */
function attachCodeCopyHandlers(container) {
  const copyButtons = container.querySelectorAll('.copy-code-btn');
  copyButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const wrapper = btn.closest('.code-block-wrapper');
      if (!wrapper) return;
      const codeEl = wrapper.querySelector('pre code');
      if (!codeEl) return;

      const codeText = codeEl.textContent;

      try {
        await navigator.clipboard.writeText(codeText);
        btn.innerHTML = '<i class="fa-solid fa-check"></i> <span>Copied!</span>';
        btn.style.color = '#8ab4f8';

        setTimeout(() => {
          btn.innerHTML = '<i class="fa-regular fa-copy"></i> <span>Copy code</span>';
          btn.style.color = '';
        }, 2000);
      } catch (err) {
        showToast('Failed to copy to clipboard', 'error');
      }
    });
  });
}

let thinkingTimers = [];

/**
 * Start Live Thinking Status with truthful, progressive updates
 */
function startThinkingStatus(modelId, thinkingLevel) {
  stopThinkingStatus();
  if (!DOM.typingIndicator) return;

  const modelName = MODEL_NAMES[modelId] || 'DRSSS AI';
  const isExtended = thinkingLevel === 'high';

  if (DOM.thinkingStatusText) {
    DOM.thinkingStatusText.style.opacity = '1';
    DOM.thinkingStatusText.textContent = 'Thinking through your question…';
  }

  if (DOM.thinkingModelTag) {
    DOM.thinkingModelTag.textContent = isExtended ? `${modelName} • Extended` : modelName;
  }

  DOM.typingIndicator.style.display = 'flex';
  scrollToBottom();

  // Natural progression reflecting genuine stages of request processing
  const stage2Delay = isExtended ? 2800 : 2200;
  const stage3Delay = isExtended ? 6500 : 5000;
  const stage4Delay = 11000;

  const t1 = setTimeout(() => {
    if (!state.isGenerating || !DOM.thinkingStatusText) return;
    updateThinkingText('Preparing a response…');
  }, stage2Delay);

  const t2 = setTimeout(() => {
    if (!state.isGenerating || !DOM.thinkingStatusText) return;
    updateThinkingText('Generating your answer…');
  }, stage3Delay);

  const t3 = setTimeout(() => {
    if (!state.isGenerating || !DOM.thinkingStatusText) return;
    updateThinkingText('Working on your response…');
  }, stage4Delay);

  thinkingTimers = [t1, t2, t3];
}

function updateThinkingText(newText) {
  if (!DOM.thinkingStatusText) return;
  DOM.thinkingStatusText.style.opacity = '0';
  setTimeout(() => {
    if (!state.isGenerating || !DOM.thinkingStatusText) return;
    DOM.thinkingStatusText.textContent = newText;
    DOM.thinkingStatusText.style.opacity = '1';
  }, 120);
}

/**
 * Stop Live Thinking Status and immediately remove loading state
 */
function stopThinkingStatus() {
  if (thinkingTimers && thinkingTimers.length > 0) {
    thinkingTimers.forEach(t => clearTimeout(t));
    thinkingTimers = [];
  }
  if (DOM.typingIndicator) {
    DOM.typingIndicator.style.display = 'none';
  }
}

/**
 * Send Message to Backend API
 */
async function handleSendMessage(messageText, isRegenerate = false) {
  const text = (messageText || DOM.chatInput.value).trim();
  if (!text || state.isGenerating) return;

  // Reset input field only if this is a new message (not regenerating)
  if (!isRegenerate) {
    DOM.chatInput.value = '';
    adjustTextareaHeight();
    updateCharCount();
  }
  DOM.sendBtn.disabled = true;

  // If currently in a draft state (no chat started yet), create conversation now
  let currentChat = state.chats.find(c => c.id === state.currentChatId);
  if (!currentChat) {
    const title = text.length > 36 ? text.substring(0, 36) + '...' : text;
    currentChat = {
      id: 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      title: title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: []
    };
    state.chats.unshift(currentChat);
    state.currentChatId = currentChat.id;
    sessionStorage.setItem('drsss_active_chat_id', currentChat.id);
  }

  // Set active thread title
  DOM.activeThreadTitle.textContent = currentChat.title;

  // Switch from welcome screen to conversation view
  DOM.welcomeScreen.style.display = 'none';
  DOM.messagesList.style.display = 'flex';

  // Record user message only if not regenerating
  if (!isRegenerate) {
    const userMsg = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString()
    };
    currentChat.messages.push(userMsg);
    currentChat.updatedAt = new Date().toISOString();
    saveUserChats();
    renderThreadsList();
    appendMessageToDOM(userMsg, true);
  }

  // Start live dynamic thinking status
  state.isGenerating = true;
  startThinkingStatus(state.selectedModel, state.thinkingLevel);
  scrollToBottom();

  // Prepare Gemini REST format history payload
  const formattedHistory = currentChat.messages.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const payload = {
    message: text,
    history: formattedHistory,
    model: state.selectedModel,
    thinking_level: state.thinkingLevel
  };

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Server returned error status ${response.status}`);
    }

    const assistantMsg = {
      role: 'assistant',
      content: data.reply || 'No response returned from the model.',
      model_used: data.model_used || state.selectedModel,
      thinking_level: data.thinking_level || state.thinkingLevel,
      fallback_used: Boolean(data.fallback_used),
      timestamp: new Date().toISOString()
    };

    currentChat.messages.push(assistantMsg);
    currentChat.updatedAt = new Date().toISOString();
    saveUserChats();

    // Immediately stop thinking status before appending final answer
    stopThinkingStatus();
    appendMessageToDOM(assistantMsg, true);

  } catch (error) {
    console.error('Chat API Error:', error);
    // Immediately stop thinking status on failure
    stopThinkingStatus();

    // Sanitize error text
    const cleanErrorMsg = (error.message || 'Unable to complete request')
      .replace(/google/gi, 'AI')
      .replace(/gemini/gi, 'DRSSS');

    const errorMsg = {
      role: 'assistant',
      content: `Unable to complete request: ${cleanErrorMsg}\n\nPlease check your network connection or server status.`,
      model_used: state.selectedModel,
      thinking_level: state.thinkingLevel,
      fallback_used: false,
      timestamp: new Date().toISOString()
    };

    currentChat.messages.push(errorMsg);
    saveUserChats();
    appendMessageToDOM(errorMsg, true);
    showToast(cleanErrorMsg, 'error');

  } finally {
    stopThinkingStatus();
    state.isGenerating = false;
    DOM.sendBtn.disabled = DOM.chatInput.value.trim().length === 0;
    DOM.chatInput.focus();
  }
}

/**
 * Regenerate Last Assistant Response
 */
function regenerateLastResponse() {
  if (state.isGenerating) return;
  const currentChat = state.chats.find(c => c.id === state.currentChatId);
  if (!currentChat || currentChat.messages.length === 0) return;

  // Find last user message
  let lastUserMsg = null;
  for (let i = currentChat.messages.length - 1; i >= 0; i--) {
    if (currentChat.messages[i].role === 'user') {
      lastUserMsg = currentChat.messages[i].content;
      break;
    }
  }

  if (!lastUserMsg) return;

  // Remove trailing assistant message if present
  if (currentChat.messages[currentChat.messages.length - 1].role === 'assistant') {
    currentChat.messages.pop();
    saveUserChats();
    renderCurrentChat();
  }

  handleSendMessage(lastUserMsg, true);
}

/**
 * Clear Current Conversation
 */
function clearCurrentChat() {
  const currentChat = state.chats.find(c => c.id === state.currentChatId);
  if (!currentChat || currentChat.messages.length === 0) return;

  currentChat.messages = [];
  currentChat.title = 'New conversation';
  currentChat.updatedAt = new Date().toISOString();
  saveUserChats();

  renderThreadsList();
  renderCurrentChat();
  showToast('Conversation cleared', 'info');
}

/**
 * Export Current Conversation as Markdown
 */
function exportCurrentChat() {
  const currentChat = state.chats.find(c => c.id === state.currentChatId);
  if (!currentChat || currentChat.messages.length === 0) {
    showToast('Nothing to export in this conversation', 'info');
    return;
  }

  let md = `# ${currentChat.title}\n`;
  md += `*Exported from DRSSS AI on ${new Date().toLocaleString()}*\n\n---\n\n`;

  currentChat.messages.forEach(m => {
    const sender = m.role === 'user' ? '### User' : `### DRSSS AI (${MODEL_NAMES[m.model_used] || 'DRSSS AI'})`;
    md += `${sender}\n\n${m.content}\n\n---\n\n`;
  });

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentChat.title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30)}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('Exported as Markdown', 'success');
}

/**
 * Auto-scroll to Bottom
 */
function scrollToBottom() {
  requestAnimationFrame(() => {
    DOM.chatViewport.scrollTop = DOM.chatViewport.scrollHeight;
  });
}

/**
 * Auto-expand Textarea Height
 */
function adjustTextareaHeight() {
  DOM.chatInput.style.height = 'auto';
  DOM.chatInput.style.height = Math.min(DOM.chatInput.scrollHeight, 180) + 'px';
}

/**
 * Character Counter
 */
function updateCharCount() {
  const len = DOM.chatInput.value.length;
  DOM.charCount.textContent = `${len}/4000`;
  DOM.sendBtn.disabled = len === 0 || state.isGenerating;
}

/**
 * Toast Notifications
 */
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  let icon = 'fa-circle-info';
  if (type === 'success') icon = 'fa-circle-check';
  if (type === 'error') icon = 'fa-circle-exclamation';

  toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${escapeHtml(message)}</span>`;
  DOM.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 3200);
}

/**
 * Escape HTML Helper
 */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Sidebar Drawer & Desktop Collapse Actions
 */
function handleSidebarCollapse() {
  if (!DOM.sidebar || !DOM.appLayout) return;
  const isCollapsed = DOM.sidebar.classList.toggle('collapsed');
  DOM.appLayout.classList.toggle('sidebar-collapsed', isCollapsed);
  state.isSidebarCollapsed = isCollapsed;
  localStorage.setItem('drsss_sidebar_collapsed', isCollapsed ? 'true' : 'false');
}

function handleSidebarExpand() {
  if (window.innerWidth <= 768) {
    if (DOM.sidebar) DOM.sidebar.classList.add('open');
    if (DOM.sidebarOverlay) DOM.sidebarOverlay.classList.add('active');
  } else {
    if (DOM.sidebar) DOM.sidebar.classList.remove('collapsed');
    if (DOM.appLayout) DOM.appLayout.classList.remove('sidebar-collapsed');
    state.isSidebarCollapsed = false;
    localStorage.setItem('drsss_sidebar_collapsed', 'false');
  }
}

function closeMobileSidebar() {
  if (DOM.sidebar) DOM.sidebar.classList.remove('open');
  if (DOM.sidebarOverlay) DOM.sidebarOverlay.classList.remove('active');
}

/**
 * Model and Thinking Selectors Dropdown Logic
 */
function closeAllDropdowns() {
  if (DOM.modelSelectorDropdown) {
    DOM.modelSelectorDropdown.classList.remove('is-open');
    DOM.modelSelectorBtn.setAttribute('aria-expanded', 'false');
  }
  if (DOM.thinkingSelectorDropdown) {
    DOM.thinkingSelectorDropdown.classList.remove('is-open');
    DOM.thinkingSelectorBtn.setAttribute('aria-expanded', 'false');
  }
}

function toggleModelDropdown(e) {
  e.stopPropagation();
  const isOpen = DOM.modelSelectorDropdown.classList.contains('is-open');
  closeAllDropdowns();
  if (!isOpen) {
    DOM.modelSelectorDropdown.classList.add('is-open');
    DOM.modelSelectorBtn.setAttribute('aria-expanded', 'true');
  }
}

function toggleThinkingDropdown(e) {
  e.stopPropagation();
  const isOpen = DOM.thinkingSelectorDropdown.classList.contains('is-open');
  closeAllDropdowns();
  if (!isOpen) {
    DOM.thinkingSelectorDropdown.classList.add('is-open');
    DOM.thinkingSelectorBtn.setAttribute('aria-expanded', 'true');
  }
}

function selectModel(modelId) {
  if (!MODEL_NAMES[modelId]) return;
  state.selectedModel = modelId;
  localStorage.setItem('drsss_selected_model', modelId);

  if (DOM.currentModelLabel) {
    DOM.currentModelLabel.textContent = MODEL_NAMES[modelId];
  }
  updateModelDropdownActiveItem(modelId);
  closeAllDropdowns();
  showToast(`Active model: ${MODEL_NAMES[modelId]}`, 'info');
}

function updateModelDropdownActiveItem(activeModelId) {
  if (!DOM.modelDropdownMenu) return;
  const items = DOM.modelDropdownMenu.querySelectorAll('.dropdown-item');
  items.forEach(item => {
    const model = item.getAttribute('data-model');
    const isActive = model === activeModelId;
    item.classList.toggle('active', isActive);
    item.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}

function selectThinkingLevel(level) {
  if (!THINKING_NAMES[level]) return;
  state.thinkingLevel = level;
  localStorage.setItem('drsss_thinking_level', level);

  if (DOM.currentThinkingLabel) {
    DOM.currentThinkingLabel.textContent = THINKING_NAMES[level];
  }
  updateThinkingDropdownActiveItem(level);
  closeAllDropdowns();
  showToast(`Reasoning level: ${THINKING_NAMES[level]}`, 'info');
}

function updateThinkingDropdownActiveItem(activeLevel) {
  if (!DOM.thinkingDropdownMenu) return;
  const items = DOM.thinkingDropdownMenu.querySelectorAll('.dropdown-item');
  items.forEach(item => {
    const level = item.getAttribute('data-thinking');
    const isActive = level === activeLevel;
    item.classList.toggle('active', isActive);
    item.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}

/**
 * Setup Event Listeners
 */
function setupEventListeners() {
  // Desktop collapse button (inside sidebar header)
  if (DOM.sidebarCollapseBtn) {
    DOM.sidebarCollapseBtn.addEventListener('click', handleSidebarCollapse);
  }

  // Mobile close button (inside sidebar header)
  if (DOM.sidebarCloseBtn) {
    DOM.sidebarCloseBtn.addEventListener('click', closeMobileSidebar);
  }

  // Topbar expand button (only visible when sidebar is collapsed or on mobile)
  if (DOM.sidebarExpandBtn) {
    DOM.sidebarExpandBtn.addEventListener('click', handleSidebarExpand);
  }

  // Backdrop overlay click
  if (DOM.sidebarOverlay) {
    DOM.sidebarOverlay.addEventListener('click', closeMobileSidebar);
  }

  // Model Selector Toggle
  if (DOM.modelSelectorBtn) {
    DOM.modelSelectorBtn.addEventListener('click', toggleModelDropdown);
  }

  // Thinking Selector Toggle
  if (DOM.thinkingSelectorBtn) {
    DOM.thinkingSelectorBtn.addEventListener('click', toggleThinkingDropdown);
  }

  // Model Dropdown Items
  if (DOM.modelDropdownMenu) {
    DOM.modelDropdownMenu.querySelectorAll('.dropdown-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const modelId = item.getAttribute('data-model');
        selectModel(modelId);
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const modelId = item.getAttribute('data-model');
          selectModel(modelId);
        }
      });
    });
  }

  // Thinking Dropdown Items
  if (DOM.thinkingDropdownMenu) {
    DOM.thinkingDropdownMenu.querySelectorAll('.dropdown-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const level = item.getAttribute('data-thinking');
        selectThinkingLevel(level);
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const level = item.getAttribute('data-thinking');
          selectThinkingLevel(level);
        }
      });
    });
  }

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown-wrapper')) {
      closeAllDropdowns();
    }
  });

  // Close dropdowns on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllDropdowns();
    }
  });

  // New Chat Button
  if (DOM.newChatBtn) {
    DOM.newChatBtn.addEventListener('click', () => createNewChat(true));
  }

  // Search input
  if (DOM.threadSearchInput) {
    DOM.threadSearchInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (DOM.clearSearchBtn) {
        DOM.clearSearchBtn.style.display = val ? 'block' : 'none';
      }
      renderThreadsList(val);
    });
  }

  if (DOM.clearSearchBtn) {
    DOM.clearSearchBtn.addEventListener('click', () => {
      DOM.threadSearchInput.value = '';
      DOM.clearSearchBtn.style.display = 'none';
      renderThreadsList();
      DOM.threadSearchInput.focus();
    });
  }

  // Download Project ZIP
  if (DOM.downloadZipBtn) {
    DOM.downloadZipBtn.addEventListener('click', () => {
      showToast('Preparing DRSSS AI Full-Stack ZIP package...', 'info');
      window.location.href = '/api/download-zip';
    });
  }

  // Topbar actions
  if (DOM.clearChatBtn) {
    DOM.clearChatBtn.addEventListener('click', clearCurrentChat);
  }
  if (DOM.exportChatBtn) {
    DOM.exportChatBtn.addEventListener('click', exportCurrentChat);
  }

  // Composer textarea input & keyboard shortcuts
  DOM.chatInput.addEventListener('input', () => {
    adjustTextareaHeight();
    updateCharCount();
  });

  DOM.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!DOM.sendBtn.disabled && !state.isGenerating) {
        handleSendMessage();
      }
    }
  });

  // Form submit
  DOM.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.isGenerating) {
      handleSendMessage();
    }
  });

  // Prompt starter cards
  DOM.promptCards.forEach(card => {
    card.addEventListener('click', () => {
      const prompt = card.getAttribute('data-prompt');
      if (prompt) {
        DOM.chatInput.value = prompt;
        adjustTextareaHeight();
        updateCharCount();
        handleSendMessage(prompt);
      }
    });
  });

  // Delete modal buttons
  if (DOM.cancelModalBtn) {
    DOM.cancelModalBtn.addEventListener('click', () => {
      if (DOM.confirmModal) DOM.confirmModal.close();
      state.pendingDeleteChatId = null;
    });
  }

  if (DOM.confirmDeleteBtn) {
    DOM.confirmDeleteBtn.addEventListener('click', () => {
      if (state.pendingDeleteChatId) {
        deleteChat(state.pendingDeleteChatId);
        state.pendingDeleteChatId = null;
      }
      if (DOM.confirmModal) DOM.confirmModal.close();
    });
  }

  // Email/password authentication modal and forms.
  if (DOM.signInFallbackBtn) DOM.signInFallbackBtn.addEventListener('click', () => openAuthModal('login'));
  if (DOM.closeAuthModalBtn) DOM.closeAuthModalBtn.addEventListener('click', closeAuthModal);
  if (DOM.showRegisterBtn) DOM.showRegisterBtn.addEventListener('click', () => setAuthView('register'));
  if (DOM.showLoginBtn) DOM.showLoginBtn.addEventListener('click', () => setAuthView('login'));
  if (DOM.authModal) {
    DOM.authModal.addEventListener('click', (event) => {
      if (event.target === DOM.authModal) closeAuthModal();
    });
  }
  document.querySelectorAll('[data-password-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.getAttribute('data-password-target'));
      if (!input) return;
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      const icon = button.querySelector('i');
      if (icon) icon.className = reveal ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
    });
  });
  if (DOM.loginForm) {
    DOM.loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const email = DOM.loginEmail.value.trim();
      const password = DOM.loginPassword.value;
      if (!email || !password) {
        showAuthError('login', 'Enter your email address and password.');
        return;
      }
      submitAuthentication('login', { email, password });
    });
  }
  if (DOM.registerForm) {
    DOM.registerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = DOM.registerName.value.trim();
      const email = DOM.registerEmail.value.trim();
      const password = DOM.registerPassword.value;
      const confirmPassword = DOM.registerConfirmPassword.value;
      if (!name || !email || !password || !confirmPassword) {
        showAuthError('register', 'Fill in all fields to create your account.');
        return;
      }
      if (password.length < 8) {
        showAuthError('register', 'Use a password with at least 8 characters.');
        return;
      }
      if (password !== confirmPassword) {
        showAuthError('register', 'The passwords do not match.');
        return;
      }
      submitAuthentication('register', { name, email, password });
    });
  }

  // Sign out button
  if (DOM.signOutBtn) {
    DOM.signOutBtn.addEventListener('click', signOut);
  }

  // Resize window listener to handle responsive transitions smoothly
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      closeMobileSidebar();
      if (state.isSidebarCollapsed) {
        if (DOM.sidebar) DOM.sidebar.classList.add('collapsed');
        if (DOM.appLayout) DOM.appLayout.classList.add('sidebar-collapsed');
      } else {
        if (DOM.sidebar) DOM.sidebar.classList.remove('collapsed');
        if (DOM.appLayout) DOM.appLayout.classList.remove('sidebar-collapsed');
      }
    }
  });
}

// Start application when DOM is ready
document.addEventListener('DOMContentLoaded', initApp);
