import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

/**
 * The customer brochure (2026-10-07): a public page at
 * app.dcsolarkc.com/brochure?rep=<slug>, personalized with the sending rep's
 * name and DC Solar number. The slug is the rep's voice identity
 * (staff_profiles.voice_identity, e.g. "gogreenken") — never their email.
 * The page reads only public_service_plans() and public_rep_contact().
 */

export const BROCHURE_BASE = 'https://app.dcsolarkc.com/brochure';

export function brochureUrl(slug: string | null | undefined): string {
  return slug ? `${BROCHURE_BASE}?rep=${encodeURIComponent(slug)}` : BROCHURE_BASE;
}

let mySlug: string | null | undefined;

/** The signed-in person's brochure link (their own slug), cached for the session. */
export function useMyBrochureLink(): string {
  const [slug, setSlug] = useState<string | null | undefined>(mySlug);
  useEffect(() => {
    if (mySlug !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data: session } = await supabase.auth.getSession();
        const email = session.session?.user.email?.toLowerCase();
        if (!email) return;
        const { data } = await supabase.from('staff_profiles').select('voice_identity').eq('email', email).maybeSingle();
        mySlug = (data as { voice_identity?: string | null } | null)?.voice_identity ?? null;
        if (!cancelled) setSlug(mySlug);
      } catch {
        // No slug: the plain page still works, with the company number.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return brochureUrl(slug);
}

export interface PublicPlan {
  tier: string;
  label: string;
  amountCents: number;
  includes: string | null;
}

export async function fetchPublicPlans(): Promise<PublicPlan[]> {
  try {
    const { data, error } = await supabase.rpc('public_service_plans');
    if (error || !data) return [];
    return (data as { tier: string; label: string; amount_cents: number; includes: string | null }[]).map((p) => ({
      tier: p.tier,
      label: p.label,
      amountCents: p.amount_cents,
      includes: p.includes,
    }));
  } catch {
    return [];
  }
}

export async function fetchRepContact(slug: string): Promise<{ name: string; phone: string | null } | null> {
  try {
    const { data, error } = await supabase.rpc('public_rep_contact', { p_slug: slug });
    const row = (data as { name: string; phone: string | null }[] | null)?.[0];
    return error || !row ? null : row;
  } catch {
    return null;
  }
}
