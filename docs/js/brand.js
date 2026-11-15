// School branding (logo + name from config.js) for headers, the sign-in card and the tab icon.

import { SCHOOL_NAME, SCHOOL_LOGO, APP_NAME } from '../config.js';

export const brandText = [SCHOOL_NAME, APP_NAME].filter(Boolean).join(' ');

function logo(cls) {
  if (!SCHOOL_LOGO) return null;
  const img = document.createElement('img');
  img.src = SCHOOL_LOGO;
  img.alt = SCHOOL_NAME ? `${SCHOOL_NAME} logo` : '';
  img.className = cls;
  img.onerror = () => img.remove(); // no logo file yet: just the name
  return img;
}

/**
 * Fill every `.brand` (header link) and `.brand-title` (big sign-in heading)
 * under `scope` with the logo and name, and use the logo as the tab icon.
 */
export function applyBrand(scope = document) {
  for (const el of scope.querySelectorAll('.brand, .brand-title')) {
    if (el.dataset.branded) continue;
    el.dataset.branded = '1';
    const big = el.classList.contains('brand-title');
    const text = document.createElement('span');
    const img = logo(big ? 'logo-big' : 'logo');
    // The logo already shows the school's name, so beside it only the app name.
    text.textContent = img ? APP_NAME || brandText : brandText;
    if (img) {
      img.onerror = () => {
        img.remove(); // no logo file: show the full name instead
        text.textContent = brandText;
      };
    }
    el.replaceChildren(...[img, text].filter(Boolean));
  }
  if (SCHOOL_LOGO && !document.querySelector('link[rel="icon"]')) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = SCHOOL_LOGO;
    document.head.append(link);
  }
  if (!document.title.includes(brandText)) document.title = document.title.replace(/ClassCode/g, brandText);
}
