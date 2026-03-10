
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
