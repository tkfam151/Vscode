// Opened from an invite (or password reset) email: lets the person choose their own password.

import { backend } from './backend.js';

const $ = (id) => document.getElementById(id);

function message(title, text) {
  $('loading').hidden = true;
  $('form').hidden = true;
  $('msgTitle').textContent = title;
  $('msgText').textContent = text;
  $('msg').hidden = false;
}

const expired = () =>
  message('This link has expired', 'Links in invite emails work once and only for a limited time. Ask your admin to send you a new one.');

try {
  const linkError = new URLSearchParams((window.ccLinkHash || '').replace(/^#/, '')).get('error');
  const user = linkError ? null : await backend.invitedUser();
  if (!user) expired();
  else {
    $('welcome').textContent = `Welcome, ${user.displayName}. Choose a password for ${user.email}.`;
    $('loading').hidden = true;
    $('form').hidden = false;
    $('pw').focus();
    $('form').onsubmit = async (ev) => {
      ev.preventDefault();
      const button = $('form').querySelector('button');
      $('err').hidden = true;
      if ($('pw').value !== $('pw2').value) {
        $('err').textContent = 'The two passwords are different.';
        $('err').hidden = false;
        return;
      }
      button.disabled = true;
      try {
        await backend.setPassword($('pw').value);
        message('Password saved', 'You are signed in. From now on, sign in with your email and this password.');
      } catch (e) {
        $('err').textContent = e.message;
        $('err').hidden = false;
        button.disabled = false;
      }
    };
  }
} catch (e) {
  console.error(e);
  expired();
}
