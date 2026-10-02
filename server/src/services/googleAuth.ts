import { OAuth2Client } from 'google-auth-library';
import { env, googleEnabled } from '../env.js';
import { ApiError } from '../lib/http.js';

const client = googleEnabled ? new OAuth2Client(env.googleClientId) : null;

export type GoogleProfile = {
  googleId: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
};

/**
 * Verifies a Google Identity Services ID token. The library checks the
 * signature against Google's rotating JWKS, the issuer, the audience and the
 * expiry — none of which we should be re-implementing by hand.
 */
export async function verifyGoogleIdToken(credential: string): Promise<GoogleProfile> {
  if (!client) {
    throw new ApiError(503, 'Google sign-in is not configured on this server', 'google_not_configured');
  }

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: env.googleClientId });
    payload = ticket.getPayload();
  } catch {
    throw ApiError.unauthorized('Google sign-in could not be verified');
  }
  if (!payload?.sub || !payload.email) throw ApiError.unauthorized('Google returned an incomplete profile');
  if (!payload.email_verified) throw ApiError.forbidden('Verify your email address with Google first');

  if (env.googleHostedDomain && payload.hd !== env.googleHostedDomain) {
    throw ApiError.forbidden(`Only ${env.googleHostedDomain} accounts can sign in here`);
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? payload.email.split('@')[0],
    picture: payload.picture,
    emailVerified: true,
  };
}
