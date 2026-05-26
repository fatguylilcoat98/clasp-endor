'use strict';
/* Test-door frontend. Vanilla; no build. */

(function () {
  const el = {
    // Login card
    loginCard:        document.getElementById('login-card'),
    loginForm:        document.getElementById('login-form'),
    loginEmail:       document.getElementById('login-email'),
    loginPassword:    document.getElementById('login-password'),
    loginSubmit:      document.getElementById('login-submit'),
    loginError:       document.getElementById('login-error'),
    showSignup:       document.getElementById('show-signup'),

    // Signup card
    signupCard:       document.getElementById('signup-card'),
    signupForm:       document.getElementById('signup-form'),
    signupEmail:      document.getElementById('signup-email'),
    signupPassword:   document.getElementById('signup-password'),
    signupDisplay:    document.getElementById('signup-displayname'),
    signupCompanion:  document.getElementById('signup-companion-name'),
    signupSubmit:     document.getElementById('signup-submit'),
    signupError:      document.getElementById('signup-error'),
    signupPending:    document.getElementById('signup-pending'),
    showLogin:        document.getElementById('show-login'),

    // Chat card
    chatCard:         document.getElementById('chat-card'),
    displayName:      document.getElementById('display-name'),
    companionLabelOut:document.getElementById('companion-label-display'),
    transcript:       document.getElementById('transcript'),
    loading:          document.getElementById('loading'),
    chatError:        document.getElementById('chat-error'),
    chatForm:         document.getElementById('chat-form'),
    chatSubmit:       document.getElementById('chat-submit'),
    messageInput:     document.getElementById('message-input'),
    logoutButton:     document.getElementById('logout-button'),

    adminCard:        document.getElementById('admin-card'),
    adminRefresh:     document.getElementById('admin-refresh'),
    adminMeta:        document.getElementById('admin-meta'),
    adminTbody:       document.getElementById('admin-tbody'),
  };

  function setText(node, text) { node.textContent = text; }
  function showError(node, message) { node.textContent = message; node.hidden = false; }
  function clearError(node) { node.textContent = ''; node.hidden = true; }
  function isAdminRole(userRole) { return userRole === 'admin'; }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* leave null */ }
    return { ok: res.ok, status: res.status, body: payload };
  }

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* leave null */ }
    return { ok: res.ok, status: res.status, body: payload };
  }

  // ---------- Auth toggles ----------
  function showLoginCard() {
    el.loginCard.hidden = false;
    el.signupCard.hidden = true;
    el.chatCard.hidden = true;
    clearError(el.loginError);
    el.signupPending.hidden = true;
  }

  function showSignupCard() {
    el.loginCard.hidden = true;
    el.signupCard.hidden = false;
    el.chatCard.hidden = true;
    clearError(el.signupError);
    el.signupPending.hidden = true;
  }

  function showChatCard(authResponse) {
    el.loginCard.hidden = true;
    el.signupCard.hidden = true;
    el.chatCard.hidden = false;
    setText(el.displayName, authResponse.displayName || authResponse.email || 'you');
    setText(
      el.companionLabelOut,
      authResponse.companionLabel ? authResponse.companionLabel : 'unnamed companion'
    );
    if (isAdminRole(authResponse.userRole)) {
      el.adminCard.hidden = false;
      refreshAdmin();
    } else {
      el.adminCard.hidden = true;
    }
    el.messageInput.focus();
  }

  // ---------- Auth submit handlers ----------
  async function onLoginSubmit(event) {
    event.preventDefault();
    clearError(el.loginError);
    el.loginSubmit.disabled = true;
    try {
      const email = el.loginEmail.value.trim();
      const password = el.loginPassword.value;
      if (!email || !password) {
        showError(el.loginError, 'Email and password are required.');
        return;
      }
      const r = await postJson('/api/login', { email, password });
      if (!r.ok) {
        // Uniform error per server.js — never leaks "no such account"
        showError(el.loginError, (r.body && r.body.error) || ('Sign-in failed (' + r.status + ').'));
        return;
      }
      // Clear password field before navigating away
      el.loginPassword.value = '';
      showChatCard(r.body);
    } catch (err) {
      showError(el.loginError, 'Network error. Try again.');
    } finally {
      el.loginSubmit.disabled = false;
    }
  }

  async function onSignupSubmit(event) {
    event.preventDefault();
    clearError(el.signupError);
    el.signupPending.hidden = true;
    el.signupSubmit.disabled = true;
    try {
      const email = el.signupEmail.value.trim();
      const password = el.signupPassword.value;
      const displayName = el.signupDisplay.value.trim();
      const companionName = el.signupCompanion.value.trim() || null;
      if (!email || !password || !displayName) {
        showError(el.signupError, 'Email, password, and your name are all required.');
        return;
      }
      if (password.length < 8) {
        showError(el.signupError, 'Password must be at least 8 characters.');
        return;
      }
      const r = await postJson('/api/signup', { email, password, displayName, companionName });
      if (!r.ok) {
        showError(el.signupError, (r.body && r.body.error) || ('Sign-up failed (' + r.status + ').'));
        return;
      }
      // Clear password field for safety
      el.signupPassword.value = '';
      if (r.body && r.body.confirmationPending) {
        // Server says: check your email, then sign in.
        el.signupPending.hidden = false;
        return;
      }
      showChatCard(r.body);
    } catch (err) {
      showError(el.signupError, 'Network error. Try again.');
    } finally {
      el.signupSubmit.disabled = false;
    }
  }

  // ---------- Chat ----------
  function renderUserMessage(text) {
    const wrap = document.createElement('div');
    wrap.className = 'message user';
    wrap.textContent = text;
    el.transcript.appendChild(wrap);
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function renderCompanionMessage(text, governance) {
    const wrap = document.createElement('div');
    wrap.className = 'message companion';
    const body = document.createElement('div');
    body.textContent = text;
    wrap.appendChild(body);
    if (governance) wrap.appendChild(renderGovPanel(governance));
    el.transcript.appendChild(wrap);
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function renderGovPanel(g) {
    const details = document.createElement('details');
    details.className = 'gov-panel';
    const summary = document.createElement('summary');
    const status = g.outcome || 'unknown';
    const auditStatus = g.auditVerdict && g.auditVerdict !== 'N/A' ? ` · audit ${g.auditVerdict.toLowerCase()}` : '';
    summary.innerHTML = 'Governance · '
      + '<span class="outcome-' + status + '">' + status + '</span>' + auditStatus;
    details.appendChild(summary);

    const dl = document.createElement('dl');
    appendKv(dl, 'memoryCount',  String(g.memoryCount != null ? g.memoryCount : '—'));
    appendKv(dl, 'decision',     String(g.decision || '—'));
    appendKv(dl, 'reason',       String(g.reason || '—'));
    appendKv(dl, 'policyRef',    String(g.policyRef || '—'));
    appendKv(dl, 'intentType',   String(g.intentType || '—'));
    appendKv(dl, 'outcome',      String(g.outcome || '—'));
    if (g.auditVerdict && g.auditVerdict !== 'N/A') {
      appendKv(dl, 'auditVerdict', String(g.auditVerdict));
      if (g.auditReason) appendKv(dl, 'auditReason', String(g.auditReason));
    }
    if (g.memoriesStored != null || g.factsExtracted != null) {
      appendKv(dl, 'memoriesStored', String(g.memoriesStored || 0));
      appendKv(dl, 'factsExtracted', String(g.factsExtracted || 0));
    }
    details.appendChild(dl);
    return details;
  }

  function appendKv(dl, key, value) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  async function onChatSubmit(event) {
    event.preventDefault();
    clearError(el.chatError);
    const message = el.messageInput.value.trim();
    if (!message) return;
    el.chatSubmit.disabled = true;
    el.loading.hidden = false;
    renderUserMessage(message);
    el.messageInput.value = '';
    try {
      const r = await postJson('/api/chat', { message });
      if (!r.ok) {
        if (r.status === 401) {
          // Session lapsed — kick back to login.
          showError(el.chatError, 'Your session expired. Please sign in again.');
          showLoginCard();
          return;
        }
        const errMsg = (r.body && r.body.error) || ('Chat failed (' + r.status + ').');
        showError(el.chatError, errMsg);
        renderCompanionMessage('[no response — see error above]', {
          outcome: 'error',
          decision: null,
          reason: r.body && r.body.errorClass ? r.body.errorClass : null,
          policyRef: null,
          intentType: null,
          memoryCount: null,
        });
        if (!el.adminCard.hidden) refreshAdmin();
        return;
      }
      const b = r.body;
      renderCompanionMessage(b.response, {
        outcome: b.outcome,
        decision: b.decision,
        reason: b.reason,
        policyRef: b.policyRef,
        intentType: b.intentType,
        memoryCount: b.memoryCount,
        auditVerdict: b.auditVerdict,
        auditReason: b.auditReason,
        memoriesStored: b.memoriesStored,
        factsExtracted: b.factsExtracted,
      });
      if (!el.adminCard.hidden) refreshAdmin();
    } catch (err) {
      showError(el.chatError, 'Network error. The companion did not respond.');
    } finally {
      el.loading.hidden = true;
      el.chatSubmit.disabled = false;
    }
  }

  async function refreshAdmin() {
    try {
      const r = await getJson('/api/admin/recent');
      if (!r.ok) {
        el.adminMeta.textContent = 'Failed to load (' + r.status + ').';
        return;
      }
      const entries = (r.body && r.body.entries) || [];
      el.adminMeta.textContent = entries.length + ' / ' + (r.body.capacity || '?') + ' shown';
      el.adminTbody.innerHTML = '';
      for (const e of entries) {
        const tr = document.createElement('tr');
        tr.appendChild(td(e.ts));
        tr.appendChild(td(e.userRole));
        tr.appendChild(td(e.outcome));
        tr.appendChild(td(e.decision));
        tr.appendChild(td(e.reason));
        tr.appendChild(td(e.memoryCount != null ? String(e.memoryCount) : ''));
        tr.appendChild(td(e.responseChars != null ? String(e.responseChars) : ''));
        tr.appendChild(td(e.errorClass));
        el.adminTbody.appendChild(tr);
      }
    } catch (err) {
      el.adminMeta.textContent = 'Network error loading recent.';
    }
  }

  function td(text) {
    const node = document.createElement('td');
    node.textContent = text == null ? '' : String(text);
    return node;
  }

  async function onLogout() {
    try { await postJson('/api/logout', {}); } catch (e) { /* swallow */ }
    window.location.reload();
  }

  // Wire events
  el.loginForm.addEventListener('submit', onLoginSubmit);
  el.signupForm.addEventListener('submit', onSignupSubmit);
  el.showSignup.addEventListener('click', showSignupCard);
  el.showLogin.addEventListener('click', showLoginCard);
  el.chatForm.addEventListener('submit', onChatSubmit);
  el.adminRefresh.addEventListener('click', refreshAdmin);
  el.logoutButton.addEventListener('click', onLogout);
  el.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      el.chatForm.requestSubmit();
    }
  });
})();
