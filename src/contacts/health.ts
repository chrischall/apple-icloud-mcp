import { getDavContext } from '../dav/icloud.js';
import { NS } from '../dav/xml.js';
import { makeProbe, type HealthProbe } from '../health.js';
import { REJECTED_HINT, resolveICloudCredentials } from '../icloud-auth.js';
import type { ContactsDeps } from './book.js';

/**
 * `contactsHealth`: are iCloud credentials configured, and does CardDAV accept
 * them right now? Discovery (reused from cache when it is known) plus one
 * PROPFIND Depth 0 on the address-book home — read-only and cheap; no cards
 * are downloaded.
 */
export function createContactsHealth(deps: Pick<ContactsDeps, 'request'> = {}): HealthProbe {
  return makeProbe({
    service: 'contacts',
    probe: 'CardDAV discovery + PROPFIND <address-book home> (Depth 0)',
    resolve: () => {
      const { username } = resolveICloudCredentials('contacts');
      return { source: 'ICLOUD_USERNAME + ICLOUD_APP_PASSWORD', detail: { appleId: username } };
    },
    run: async () => {
      const ctx = await getDavContext('contacts', deps);
      await ctx.client.propfind(ctx.homeUrl, [[NS.DAV, 'resourcetype']], 0);
      return {
        notes: [
          ctx.source === 'discovered'
            ? 'CardDAV discovery ran now and was cached.'
            : `CardDAV discovery was reused from the ${ctx.source} cache.`,
        ],
      };
    },
    rejectedHint: REJECTED_HINT,
  });
}

export const contactsHealth: HealthProbe = createContactsHealth();
