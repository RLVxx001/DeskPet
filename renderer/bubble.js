const el = document.getElementById('bubble')
window.deskPet.onChat((payload) => {
  if (payload?.bubble) el.textContent = payload.bubble
})
