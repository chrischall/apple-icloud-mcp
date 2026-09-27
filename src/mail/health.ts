import { AppleToolError } from '../errors.js';
import { makeProbe, type HealthProbe } from '../health.js';
import { REJECTED_HINT } from '../icloud-auth.js';
import { IMAP_HOST, IMAP_PORT, SMTP_HOST, SMTP_PORT, mailProxyFor, resolveMailAccount } from './config.js';
import { defaultCreateImapClient, mapImapError, withImap, type CreateImapClient } from './imap.js';

/**
 * `mailHealth`: is the iCloud Mail account configured, and does IMAP accept
 * it right now? One sign-in plus `STATUS INBOX` (read-only; nothing is
 * selected, so nothing can be marked read), then logout.
 */
export function createMailHealth(createImapClient: CreateImapClient = defaultCreateImapClient): HealthProbe {
  return makeProbe({
    service: 'mail',
    probe: `IMAP sign-in + STATUS INBOX (${IMAP_HOST}:${IMAP_PORT})`,
    resolve: () => {
      const account = resolveMailAccount();
      return {
        source:
          account.addressSource === 'ICLOUD_MAIL_ADDRESS'
            ? 'ICLOUD_MAIL_ADDRESS + ICLOUD_USERNAME + ICLOUD_APP_PASSWORD'
            : 'ICLOUD_USERNAME + ICLOUD_APP_PASSWORD',
        detail: {
          address: account.address,
          imap: `${IMAP_HOST}:${IMAP_PORT}`,
          smtp: `${SMTP_HOST}:${SMTP_PORT}`,
          viaProxy: mailProxyFor(IMAP_HOST) !== undefined,
        },
      };
    },
    run: async () => {
      const account = resolveMailAccount();
      return withImap(createImapClient, account, async ({ client, loginAs }) => {
        let status;
        try {
          status = await client.status('INBOX', { messages: true, unseen: true });
        } catch (err) {
          throw mapImapError(err, 'STATUS INBOX');
        }
        if (!status || typeof status.messages !== 'number') {
          throw new AppleToolError('UPSTREAM_ERROR', 'iCloud Mail signed in but did not report the INBOX status.');
        }
        return {
          notes: [
            `INBOX: ${status.messages} messages${typeof status.unseen === 'number' ? `, ${status.unseen} unread` : ''}.`,
            `IMAP accepted the ${loginAs === 'local' ? 'name part of the address' : 'full address'} as the username.`,
            'SMTP (sending) is not probed here; it is used only by apple_mail_send.',
          ],
        };
      });
    },
    rejectedHint: REJECTED_HINT,
  });
}

export const mailHealth: HealthProbe = createMailHealth();
