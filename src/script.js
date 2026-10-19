// ClipFlip — script.js
// Lightweight interactivity — no framework needed.

document.addEventListener('DOMContentLoaded', () => {
  // Parallax on mouse move
  const hero = document.querySelector('.hero__content');
  document.addEventListener('mousemove', (e) => {
    const x = (e.clientX / window.innerWidth  - 0.5) * 20;
    const y = (e.clientY / window.innerHeight - 0.5) * 20;
    hero.style.transform = `translate(${x * 0.3}px, ${y * 0.3}px)`;
  });

  // Update status badge with deploy time if available
  const badge = document.querySelector('.status-badge span:last-child');
  const deployTime = document.documentElement.dataset.deployTime;
  if (deployTime) {
    badge.textContent = `Deployed ${deployTime}`;
  }
});
