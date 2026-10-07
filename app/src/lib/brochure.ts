import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

/**
 * The customer brochure (2026-10-07): a public page at
 * app.dcsolarkc.com/brochure?rep=<slug>, personalized with the sending rep's
 * name and DC Solar number. The slug is the rep's FIRST NAME ("ken"; "ken2"
 * if two share one — staff_profiles.brochure_slug via my_brochure_slug(),
 * 2026-10-08). Links sent before that used the voice identity
 * ("gogreenken") and still work.
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
        if (!session.session) return;
        const { data } = await supabase.rpc('my_brochure_slug');
        mySlug = typeof data === 'string' && data ? data : null;
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
