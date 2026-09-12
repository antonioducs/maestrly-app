import { api } from '../../app/api.js'
import { FormDialog } from '../../components/FormDialog.js'
import { t, useLocale } from '../../i18n/index.js'

export function AccountDialog({
  user,
  onClose,
  onChanged,
}: {
  user: { name: string; email: string }
  onClose(): void
  onChanged(): void
}) {
  useLocale()
  return (
    <FormDialog
      title={t('My account')}
      submitLabel={t('Change password')}
      onClose={onClose}
      onSubmit={async (data) => {
        const currentPassword = String(data.get('currentPassword') ?? ''),
          newPassword = String(data.get('newPassword') ?? ''),
          confirmation = String(data.get('confirmation') ?? '')
        if (newPassword !== confirmation) throw new Error('The new passwords do not match.')
        if (newPassword.length < 12 || newPassword.length > 128)
          throw new Error('Use between 12 and 128 characters for the new password.')
        await api('/api/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: false }),
        })
        onChanged()
      }}
    >
      <p className="form-note">
        {user.name}
        <br />
        {user.email}
      </p>
      <label>
        {t('Current password')}
        <input name="currentPassword" type="password" required maxLength={128} autoComplete="current-password" />
      </label>
      <label>
        {t('New password')}
        <input name="newPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
      </label>
      <label>
        {t('Confirm new password')}
        <input
          name="confirmation"
          type="password"
          required
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
        />
      </label>
      <p className="form-note">{t('Use between 12 and 128 characters for the new password.')}</p>
    </FormDialog>
  )
}
