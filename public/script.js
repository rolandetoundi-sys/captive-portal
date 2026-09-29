(() => {
  'use strict';

  // --- Paramètres passés par UniFi dans l'URL de redirection ---
  // ex: ?ap=94:2a:6f:d0:30:57&id=1c:71:25:63:e4:24&t=...&url=...&ssid=...
  const params = new URLSearchParams(window.location.search);
  const context = {
    clientMac: params.get('id') || null,
    apMac: params.get('ap') || null,
    ssid: params.get('ssid') || null,
    redirectUrl: params.get('url') || null,
  };

  if (context.ssid) {
    document.getElementById('eyebrow').textContent = context.ssid;
  }

  // --- Références DOM ---
  const steps = {
    phone: document.getElementById('step-phone'),
    register: document.getElementById('step-register'),
    otp: document.getElementById('step-otp'),
    identifier: document.getElementById('step-identifier'),
    success: document.getElementById('step-success'),
    error: document.getElementById('step-error'),
  };

  const tabNew = document.getElementById('tab-new');
  const tabReturning = document.getElementById('tab-returning');

  const phonePill = document.getElementById('phone-pill');
  const phonePillValue = document.getElementById('phone-pill-value');

  const formPhone = document.getElementById('form-phone');
  const inputPhone = document.getElementById('input-phone');
  const errorPhone = document.getElementById('error-phone');
  const btnPhoneSubmit = document.getElementById('btn-phone-submit');

  const formRegister = document.getElementById('form-register');
  const inputName = document.getElementById('input-name');
  const inputEmail = document.getElementById('input-email');
  const errorName = document.getElementById('error-name');
  const errorEmail = document.getElementById('error-email');
  const btnRegisterSubmit = document.getElementById('btn-register-submit');

  const formOtp = document.getElementById('form-otp');
  const inputOtp = document.getElementById('input-otp');
  const errorOtp = document.getElementById('error-otp');
  const otpSubcopy = document.getElementById('otp-subcopy');
  const btnOtpSubmit = document.getElementById('btn-otp-submit');
  const btnOtpResend = document.getElementById('btn-otp-resend');

  const formIdentifier = document.getElementById('form-identifier');
  const inputIdentifier = document.getElementById('input-identifier');
  const errorIdentifier = document.getElementById('error-identifier');
  const btnIdentifierSubmit = document.getElementById('btn-identifier-submit');

  const successHeading = document.getElementById('success-heading');
  const successSubcopy = document.getElementById('success-subcopy');
  const btnContinue = document.getElementById('btn-continue');

  const errorMessage = document.getElementById('error-message');
  const btnRetry = document.getElementById('btn-retry');

  let currentPhone = '';
  let currentName = '';
  let currentMode = 'new';

  function showStep(name) {
    Object.values(steps).forEach((el) => { el.hidden = true; });
    steps[name].hidden = false;
  }

  function setFieldError(el, message) {
    if (message) {
      el.textContent = message;
      el.hidden = false;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  function showPhonePill(phone) {
    phonePillValue.textContent = phone;
    phonePill.hidden = false;
  }

  function hidePhonePill() {
    phonePill.hidden = true;
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function showSuccess({ firstName, authorized, isReturning }) {
    if (isReturning) {
      successHeading.textContent = firstName ? `Bon retour, ${firstName}.` : 'Bon retour parmi nous.';
    } else {
      successHeading.textContent = firstName ? `Merci, ${firstName}.` : 'Vous êtes connecté.';
    }

    if (authorized) {
      successSubcopy.textContent = context.redirectUrl
        ? 'Redirection en cours...'
        : 'Vous pouvez fermer cette page et naviguer normalement.';
    } else {
      successSubcopy.textContent = "Vos informations sont enregistrées, mais la connexion automatique a échoué. Merci de contacter le personnel sur place.";
    }

    showStep('success');

    if (authorized && context.redirectUrl) {
      btnContinue.hidden = false;
      const target = decodeURIComponent(context.redirectUrl);
      btnContinue.onclick = () => { window.location.href = target; };
      window.setTimeout(() => { window.location.href = target; }, 1800);
    } else {
      btnContinue.hidden = true;
    }
  }

  function showError(message) {
    errorMessage.textContent = message || 'Merci de réessayer dans un instant.';
    showStep('error');
  }

  // --- Bascule entre les deux parcours ---
  function setMode(mode) {
    currentMode = mode;
    tabNew.classList.toggle('active', mode === 'new');
    tabNew.setAttribute('aria-selected', String(mode === 'new'));
    tabReturning.classList.toggle('active', mode === 'returning');
    tabReturning.setAttribute('aria-selected', String(mode === 'returning'));

    hidePhonePill();
    setFieldError(errorPhone, null);
    setFieldError(errorIdentifier, null);

    if (mode === 'new') {
      showStep('phone');
      inputPhone.focus();
    } else {
      showStep('identifier');
      inputIdentifier.focus();
    }
  }

  tabNew.addEventListener('click', () => setMode('new'));
  tabReturning.addEventListener('click', () => setMode('returning'));

  // --- Parcours "Première connexion", étape 1 : téléphone ---
  formPhone.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFieldError(errorPhone, null);

    const phone = inputPhone.value.trim();
    if (!phone) {
      setFieldError(errorPhone, "Merci d'entrer votre numéro.");
      return;
    }

    btnPhoneSubmit.disabled = true;
    btnPhoneSubmit.textContent = 'Vérification...';

    try {
      const { ok, data } = await postJSON('/api/lookup', { phone });

      if (!ok) {
        setFieldError(errorPhone, data.error || 'Numéro invalide.');
        return;
      }

      if (data.found) {
        setFieldError(errorPhone, 'Ce numéro est déjà enregistré. Utilisateur « Déjà enregistré ».');
        return;
      }

      currentPhone = phone;
      showPhonePill(phone);
      showStep('register');
      inputName.focus();
    } catch (err) {
      showError('Impossible de contacter le portail. Vérifiez votre connexion et réessayez.');
    } finally {
      btnPhoneSubmit.disabled = false;
      btnPhoneSubmit.textContent = 'Continuer';
    }
  });

  // --- Parcours "Première connexion", étape 2 : nom + email -> envoi du code ---
  formRegister.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFieldError(errorName, null);
    setFieldError(errorEmail, null);

    const name = inputName.value.trim();
    const email = inputEmail.value.trim();
    let hasError = false;

    if (!name) {
      setFieldError(errorName, "Merci d'entrer votre nom.");
      hasError = true;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldError(errorEmail, 'Une adresse email valide est requise.');
      hasError = true;
    }
    if (hasError) return;

    btnRegisterSubmit.disabled = true;
    btnRegisterSubmit.textContent = 'Envoi du code...';

    try {
      const { ok, data } = await postJSON('/api/register/start', {
        name,
        email,
        phone: currentPhone,
        clientMac: context.clientMac,
        apMac: context.apMac,
      });

      if (!ok) {
        showError(data.error || "Impossible d'envoyer le code de vérification.");
        return;
      }

      currentName = name;
      otpSubcopy.textContent = `Entrez le code à 6 chiffres envoyé à ${email}.`;
      inputOtp.value = '';
      setFieldError(errorOtp, null);
      showStep('otp');
      inputOtp.focus();
    } catch (err) {
      showError('Impossible de contacter le portail. Vérifiez votre connexion et réessayez.');
    } finally {
      btnRegisterSubmit.disabled = false;
      btnRegisterSubmit.textContent = 'Recevoir mon code';
    }
  });

  // --- Parcours "Première connexion", étape 3 : validation du code ---
  formOtp.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFieldError(errorOtp, null);

    const code = inputOtp.value.trim();
    if (!code) {
      setFieldError(errorOtp, 'Merci d\'entrer le code reçu par email.');
      return;
    }

    btnOtpSubmit.disabled = true;
    btnOtpSubmit.textContent = 'Vérification...';

    try {
      const { ok, data } = await postJSON('/api/register/verify', {
        phone: currentPhone,
        code,
      });

      if (!ok) {
        setFieldError(errorOtp, data.error || 'Code incorrect.');
        return;
      }

      showSuccess({ firstName: data.firstName || currentName.split(' ')[0], authorized: data.authorized, isReturning: false });
    } catch (err) {
      showError('Impossible de contacter le portail. Vérifiez votre connexion et réessayez.');
    } finally {
      btnOtpSubmit.disabled = false;
      btnOtpSubmit.textContent = 'Valider et se connecter';
    }
  });

  // --- Renvoyer un nouveau code ---
  btnOtpResend.addEventListener('click', async () => {
    setFieldError(errorOtp, null);
    btnOtpResend.disabled = true;
    btnOtpResend.textContent = 'Envoi...';

    try {
      const { ok, data } = await postJSON('/api/register/resend', { phone: currentPhone });
      if (!ok) {
        setFieldError(errorOtp, data.error || "Impossible de renvoyer le code.");
        return;
      }
      setFieldError(errorOtp, null);
    } catch (err) {
      setFieldError(errorOtp, 'Impossible de contacter le portail.');
    } finally {
      btnOtpResend.disabled = false;
      btnOtpResend.textContent = 'Renvoyer le code';
    }
  });

  // --- Parcours "Déjà enregistré" : nom ou email -> connexion directe ---
  formIdentifier.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFieldError(errorIdentifier, null);

    const identifier = inputIdentifier.value.trim();
    if (!identifier) {
      setFieldError(errorIdentifier, 'Merci d\'entrer votre numéro de téléphone ou votre email.');
      return;
    }

    btnIdentifierSubmit.disabled = true;
    btnIdentifierSubmit.textContent = 'Connexion...';

    try {
      const { ok, data } = await postJSON('/api/checkin', {
        identifier,
        clientMac: context.clientMac,
        apMac: context.apMac,
      });

      if (!ok) {
        setFieldError(errorIdentifier, data.error || 'Aucun compte trouvé.');
        return;
      }

      showSuccess({ firstName: data.firstName, authorized: data.authorized, isReturning: true });
    } catch (err) {
      showError('Impossible de contacter le portail. Vérifiez votre connexion et réessayez.');
    } finally {
      btnIdentifierSubmit.disabled = false;
      btnIdentifierSubmit.textContent = 'Se connecter à internet';
    }
  });

  // --- Puce téléphone : revenir à l'étape 1 pour corriger le numéro ---
  phonePill.addEventListener('click', () => {
    hidePhonePill();
    showStep('phone');
    inputPhone.focus();
    inputPhone.select();
  });

  // --- Réessayer après une erreur générique ---
  btnRetry.addEventListener('click', () => {
    setMode(currentMode);
  });

  setMode('new');
})();

