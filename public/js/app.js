// App shell: screen switching (login / live monitor / report), tab wiring, sign in/out.
(() => {
  const screens = {
    login: document.getElementById('loginScreen'),
    live: document.getElementById('liveScreen'),
    report: document.getElementById('reportScreen'),
  };

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => { el.hidden = key !== name; });
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === name);
    });

    if (name === 'live') LiveMonitor.start();
    else LiveMonitor.stop();

    if (name === 'report') Report.start();
  }

  function setLoginError(message) {
    const el = document.getElementById('loginError');
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = message;
  }

  async function signOut() {
    try { await Api.logout(); } catch { /* best effort */ }
    LiveMonitor.stop();
    document.getElementById('loginUsername').value = '';
    document.getElementById('loginPassword').value = '';
    setLoginError(null);
    showScreen('login');
  }

  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    setLoginError(null);
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    try {
      await Api.login(username, password);
      showScreen('live');
    } catch (err) {
      setLoginError(err.status === 401 ? 'Incorrect username or password.' : `Sign-in failed: ${err.message}`);
    }
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.tab));
  });

  document.getElementById('signOutBtnLive').addEventListener('click', signOut);
  document.getElementById('signOutBtnReport').addEventListener('click', signOut);

  // Resume an existing session (cookie) without re-showing the login screen.
  (async () => {
    try {
      const { authed } = await Api.me();
      showScreen(authed ? 'live' : 'login');
    } catch {
      showScreen('login');
    }
  })();
})();
