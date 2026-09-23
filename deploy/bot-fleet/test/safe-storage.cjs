const { app, safeStorage } = require('electron')
app.whenReady().then(() => {
  const available = safeStorage.isEncryptionAvailable()
  const backend = safeStorage.getSelectedStorageBackend?.()
  const roundTrip = available && safeStorage.decryptString(safeStorage.encryptString('fleet-probe')) === 'fleet-probe'
  console.log(JSON.stringify({ available, backend, roundTrip }))
  app.quit()
})
