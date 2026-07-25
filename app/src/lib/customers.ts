/**
 * Customers data layer — the company contact book. All members can read;
 * admins add and edit (insert/update policies may not be applied yet, so
 * mutation errors surface as friendly messages). RLS enforced.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export interface CustomerRecord {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
}

export interface CustomerInput {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
}

export type CustomersResult =
  | { status: 'ok'; customers: CustomerRecord[] }
  | { status: 'unavailable' };

/** Fetch all customers, alphabetical by name. */
export async function fetchCustomers(): Promise<CustomersResult> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, email, phone, address, notes')
      .eq('company', COMPANY)
      .order('name', { ascending: true });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', customers: (data ?? []) as CustomerRecord[] };
  } catch {
    return { status: 'unavailable' };
  }
}

export type CustomerMutationResult = { ok: true } | { ok: false; message: string };

function friendlyMessage(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  // Policy not applied yet / RLS denial reads badly raw — soften it.
  if (/row-level security|policy/i.test(raw)) {
    return 'Saving customers needs the latest database migration.';
  }
  return raw;
}

/** Admin: add a customer. */
export async function addCustomer(input: CustomerInput): Promise<CustomerMutationResult> {
  try {
    const { error } = await supabase.from('customers').insert({
      company: COMPANY,
      name: input.name,
      email: input.email,
      phone: input.phone,
      address: input.address,
      notes: input.notes,
    });
    if (error) {
      return { ok: false, message: friendlyMessage(error.message, 'Could not add the customer.') };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not add the customer.' };
  }
}

/** Admin: update an existing customer. */
export async function updateCustomer(
  id: string,
  input: CustomerInput,
): Promise<CustomerMutationResult> {
  try {
    const { error } = await supabase
      .from('customers')
      .update({
        name: input.name,
        email: input.email,
        phone: input.phone,
        address: input.address,
        notes: input.notes,
      })
      .eq('id', id)
      .eq('company', COMPANY);
    if (error) {
      return { ok: false, message: friendlyMessage(error.message, 'Could not save the change.') };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the change.' };
  }
}
