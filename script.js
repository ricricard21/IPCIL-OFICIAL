
const menuToggle = document.getElementById('menuToggle');
const mainNav = document.getElementById('mainNav');

if (menuToggle && mainNav) {
  menuToggle.addEventListener('click', () => {
    mainNav.classList.toggle('open');
  });

  mainNav.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => mainNav.classList.remove('open'));
  });
}

const validateForm = document.getElementById('validateForm');
if (validateForm) {
  validateForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const folio = document.getElementById('folio').value.trim();

    if (!folio) {
      alert('Por favor ingresa un folio para continuar.');
      return;
    }

    alert(
      'Módulo visual listo.\n\n' +
      'Folio capturado: ' + folio + '\n\n' +
      'En la siguiente etapa se conecta este formulario a tu base de datos o sistema de validación real.'
    );
  });
}


// Header premium on scroll
const siteHeader = document.querySelector('.site-header');
window.addEventListener('scroll', () => {
  if (!siteHeader) return;
  if (window.scrollY > 24) {
    siteHeader.classList.add('scrolled');
  } else {
    siteHeader.classList.remove('scrolled');
  }
});

// Scroll reveal
const revealItems = document.querySelectorAll('.reveal');
if (revealItems.length) {
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.14 });

  revealItems.forEach((item) => revealObserver.observe(item));
}

// Animated counters
const counters = document.querySelectorAll('.counter');
if (counters.length) {
  const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;

      const el = entry.target;
      const target = Number(el.dataset.target || 0);
      const suffix = el.dataset.suffix || '';
      let current = 0;
      const duration = 1400;
      const steps = 45;
      const increment = target / steps;
      const stepTime = duration / steps;

      const timer = setInterval(() => {
        current += increment;
        if (current >= target) {
          el.textContent = `${target}${suffix}`;
          clearInterval(timer);
        } else {
          el.textContent = `${Math.floor(current)}${suffix}`;
        }
      }, stepTime);

      counterObserver.unobserve(el);
    });
  }, { threshold: 0.45 });

  counters.forEach((counter) => counterObserver.observe(counter));
}
