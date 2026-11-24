/**
 * Application bootstrap: session restore, sign-in, language switching,
 * navigation chrome and notification polling.
 */
"use strict";

(function () {
  const KRY = window.KRY;
  const t = (key, vars) => KRY.t(key, vars);
  const {
    el,
    api,
    toast,
    updateChrome,
    refreshNotifications,
    renderRoute,
    navigate,
  } = KRY;

  const loginScreen = document.getElementById("loginScreen");
  const appShell = document.getElementById("appShell");
  const loginForm = document.getElementById("loginForm");
  const loginEmail = document.getElementById("loginEmail");
  const loginPassword = document.getElementById("loginPassword");
  const loginCredentials = document.getElementById("loginCredentials");
  const login2fa = document.getElementById("login2fa");
  const login2faCode = document.getElementById("login2faCode");
  const loginError = document.getElementById("loginError");
  const loginButton = document.getElementById("loginButton");
  const sidebar = document.getElementById("sidebar");

  let pending2faToken = null;
  const notifyPanel = document.getElementById("notifyPanel");
  const notifyButton = document.getElementById("notifyButton");
  const notifyList = document.getElementById("notifyList");
  const langButton = document.getElementById("langButton");
  const langPanel = document.getElementById("langPanel");

  let notificationTimer = null;
  const welcomeHero = document.getElementById('welcomeHero');
  const openLogin = () => {
    loginScreen.classList.add('show-login');
    welcomeHero.hidden = true;
    loginEmail.focus();
  };
  document.getElementById('welcomeSignIn').addEventListener('click', openLogin);
  document.getElementById('backToWelcome').addEventListener('click', () => {
    loginScreen.classList.remove('show-login');
    welcomeHero.hidden = false;
    document.getElementById('welcomeSignIn').focus();
  });

  document.querySelector('.skip-link')?.addEventListener('click', (event) => {
    event.preventDefault();
    if (appShell.hidden) openLogin();
    else document.getElementById('view').focus();
  });

  /* --------------------------------------------------------------- Language */

  function closeLangPanel() {
    langPanel.hidden = true;
    langButton.setAttribute("aria-expanded", "false");
  }

  langButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = langPanel.hidden;
    langPanel.hidden = !open;
    langButton.setAttribute("aria-expanded", String(open));
  });

  langPanel.addEventListener("click", (event) => event.stopPropagation());

  document.querySelectorAll("[data-locale]").forEach((button) => {
    button.addEventListener("click", () => {
      KRY.setLocale(button.dataset.locale);
      closeLangPanel();
    });
  });

  // Rebuild the visible chrome and the current screen in the new language.
  KRY.onLocaleChange = () => {
    if (KRY.state.user) {
      updateChrome();
      renderRoute();
    } else {
      loginButton.textContent = t("login.signIn");
      KRY.applyStaticText(document);
    }
  };

  /* --------------------------------------------------------------- Session */

  function showLogin(message) {
    KRY.clearSession();
    if (notificationTimer) {
      clearInterval(notificationTimer);
      notificationTimer = null;
    }
    KRY.closeModal();
    appShell.hidden = true;
    loginScreen.hidden = false;
    loginPassword.value = "";
    pending2faToken = null;
    if (loginCredentials) loginCredentials.hidden = false;
    if (login2fa) login2fa.hidden = true;
    if (login2faCode) login2faCode.value = "";
    loginButton.textContent = t("login.signIn");
    notifyPanel.hidden = true;
    notifyButton.setAttribute("aria-expanded", "false");
    closeLangPanel();
    if (message) {
      loginError.textContent = message;
      loginError.hidden = false;
    }
    setTimeout(() => loginScreen.classList.contains('show-login') ? loginEmail.focus() : document.getElementById('welcomeSignIn').focus(), 30);
  }
  KRY.showLogin = showLogin;

  function showApp(user) {
    loginScreen.hidden = true;
    appShell.hidden = false;
    loginError.hidden = true;
    updateChrome();
    if (!notificationTimer) {
      notificationTimer = setInterval(refreshNotifications, 60_000);
    }
    refreshNotifications();
    if (!location.hash || location.hash === "#") {
      location.hash = "#/overview";
    } else {
      renderRoute();
    }
  }

  async function restoreSession() {
    try {
      const user = await api("/me");
      KRY.setSession("", user);
      showApp(user);
    } catch {
      showLogin();
    }
  }

  /* ----------------------------------------------------------------- Login */

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError.hidden = true;

    if (pending2faToken) {
      const code = login2faCode ? login2faCode.value.trim() : "";
      if (!code) {
        loginError.textContent = "Please enter your 2FA code or recovery code.";
        loginError.hidden = false;
        return;
      }
      loginButton.disabled = true;
      loginButton.textContent = t("login.signingIn");
      try {
        const result = await api("/login/2fa", {
          method: "POST",
          body: { tempToken: pending2faToken, code },
        });
        KRY.setSession(result.token, result.user);
        pending2faToken = null;
        if (login2faCode) login2faCode.value = "";
        if (login2fa) login2fa.hidden = true;
        if (loginCredentials) loginCredentials.hidden = false;
        showApp(result.user);
        toast(t("toast.signedIn", { name: result.user.name }), "success");
      } catch (err) {
        loginError.textContent = err.message;
        loginError.hidden = false;
        if (login2faCode) login2faCode.focus();
      } finally {
        loginButton.disabled = false;
        loginButton.textContent = "Verify code";
      }
      return;
    }

    const email = loginEmail.value.trim();
    const password = loginPassword.value;

    if (!email || !password) {
      loginError.textContent = t("login.errorRequired");
      loginError.hidden = false;
      return;
    }

    loginButton.disabled = true;
    loginButton.textContent = t("login.signingIn");
    try {
      const result = await api("/login", {
        method: "POST",
        body: { email, password },
      });

      if (result.requires2FA) {
        pending2faToken = result.tempToken;
        if (loginCredentials) loginCredentials.hidden = true;
        if (login2fa) login2fa.hidden = false;
        loginButton.textContent = "Verify code";
        loginError.hidden = true;
        setTimeout(() => login2faCode && login2faCode.focus(), 30);
        return;
      }

      KRY.setSession(result.token, result.user);
      loginPassword.value = "";
      showApp(result.user);
      toast(t("toast.signedIn", { name: result.user.name }), "success");
    } catch (err) {
      loginError.textContent = err.message;
      loginError.hidden = false;
      loginPassword.focus();
    } finally {
      loginButton.disabled = false;
      if (!pending2faToken) loginButton.textContent = t("login.signIn");
    }
  });

  /* ---------------------------------------------------------------- Logout */

  document
    .getElementById("logoutButton")
    .addEventListener("click", async () => {
      try {
        await api("/logout", { method: "POST" });
      } catch {
        /* the local session is cleared regardless */
      }
      showLogin();
      toast(t("toast.signedOut"), "success");
    });

  /* ------------------------------------------------------------ Navigation */

  document.getElementById("nav").addEventListener("click", (event) => {
    const button = event.target.closest(".nav-item");
    if (!button || button.hidden) return;
    navigate(button.dataset.page);
  });

  window.addEventListener("hashchange", () => {
    if (KRY.state.user) renderRoute();
  });

  document.getElementById("menuButton").addEventListener("click", () => {
    sidebar.classList.toggle("open");
  });

  document.getElementById("view").addEventListener("click", (event) => {
    if (window.innerWidth <= 960 && !sidebar.contains(event.target)) {
      sidebar.classList.remove("open");
    }
  });

  /* --------------------------------------------------------- Notifications */

  notifyButton.addEventListener("click", (event) => {
    event.stopPropagation();
    closeLangPanel();
    const open = notifyPanel.hidden;
    notifyPanel.hidden = !open;
    notifyButton.setAttribute("aria-expanded", String(open));
    if (open) refreshNotifications();
  });

  notifyPanel.addEventListener("click", (event) => event.stopPropagation());

  document
    .getElementById("notifyReadAll")
    .addEventListener("click", async () => {
      try {
        await api("/notifications/read-all", { method: "PATCH" });
        await refreshNotifications();
        toast(t("toast.allRead"), "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });

  document.addEventListener("click", () => {
    if (!notifyPanel.hidden) {
      notifyPanel.hidden = true;
      notifyButton.setAttribute("aria-expanded", "false");
    }
    if (!langPanel.hidden) closeLangPanel();
  });

  /* ---------------------------------------------------------- Modal / keys */

  document.getElementById("modalRoot").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) KRY.closeModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!document.getElementById("modalRoot").hidden) {
        KRY.closeModal();
      } else if (!notifyPanel.hidden) {
        notifyPanel.hidden = true;
        notifyButton.setAttribute("aria-expanded", "false");
      } else if (!langPanel.hidden) {
        closeLangPanel();
      } else if (window.innerWidth <= 960) {
        sidebar.classList.remove("open");
      }
    }
  });

  /* ------------------------------------------------------------- Bootstrap */

  KRY.applyStaticText(document);
  KRY.setLocale(KRY.locale(), { silent: true });

  if (notifyList && !notifyList.childElementCount) {
    notifyList.appendChild(
      el("div", { class: "empty-state", text: t("common.loading") }),
    );
  }

  restoreSession();
})();
