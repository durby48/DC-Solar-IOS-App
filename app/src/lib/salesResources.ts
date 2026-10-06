import { supabase } from '@/lib/supabase';

/**
 * Sales resources (2026-10-07): the brochure PDF, the call script, situations
 * and objections — `sales_resources` (2026-10-07_sales_resources.sql) plus the
 * private 'sales-resources' storage bucket for files. Every employee reads;
 * admins write (CRM Settings → Sales resources). Files open through a signed
 * URL that lasts an hour.
 */

const COMPANY = 'dc-solar';
const BUCKET = 'sales-resources';

export type ResourceKind = 'script' | 'situation' | 'objection' | 'file';

export interface SalesResource {
  id: string;
  kind: ResourceKind;
  title: string;
  body: string | null;
  filePath: string | null;
  sort: number;
  updatedAt: string;
}

type Result = { ok: true } | { ok: false; message: string };

export async function fetchResources(): Promise<SalesResource[]> {
  try {
    const { data, error } = await supabase
      .from('sales_resources')
      .select('id, kind, title, body, file_path, sort, updated_at')
      .eq('company', COMPANY)
      .order('sort')
      .order('title');
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      kind: r.kind as ResourceKind,
      title: r.title as string,
      body: (r.body as string | null) ?? null,
      filePath: (r.file_path as string | null) ?? null,
      sort: (r.sort as number) ?? 100,
      updatedAt: r.updated_at as string,
    }));
  } catch {
    return [];
  }
}

export async function fetchResource(id: string): Promise<SalesResource | null> {
  return (await fetchResources()).find((r) => r.id === id) ?? null;
}

/** Admin: add (no id) or edit a text resource. */
export async function saveResource(input: {
  id?: string;
  kind: Exclude<ResourceKind, 'file'>;
  title: string;
  body: string;
  sort?: number;
}): Promise<Result> {
  try {
    const title = input.title.trim();
    if (!title) return { ok: false, message: 'Give it a title.' };
    const { data: session } = await supabase.auth.getSession();
    const row = {
      company: COMPANY,
      kind: input.kind,
      title,
      body: input.body.trim() || null,
      updated_at: new Date().toISOString(),
      updated_by: session.session?.user.email ?? null,
      ...(input.sort !== undefined ? { sort: input.sort } : {}),
    };
    const { data, error } = input.id
      ? await supabase.from('sales_resources').update(row).eq('id', input.id).select('id')
      : await supabase.from('sales_resources').insert(row).select('id');
    if (error || !data?.length) return { ok: false, message: error?.message ?? 'Not saved — admins only.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Not saved.' };
  }
}

export async function deleteResource(resource: SalesResource): Promise<Result> {
  try {
    if (resource.filePath) await supabase.storage.from(BUCKET).remove([resource.filePath]);
    const { data, error } = await supabase.from('sales_resources').delete().eq('id', resource.id).select('id');
    if (error || !data?.length) return { ok: false, message: error?.message ?? 'Not deleted — admins only.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Not deleted.' };
  }
}

/** Admin: upload a PDF (the brochure). Replaces the file of `replace` if given. */
export async function uploadResourceFile(input: {
  title: string;
  fileName: string;
  uri: string;
  contentType: string;
  replace?: SalesResource | null;
}): Promise<Result> {
  try {
    const body = await (await fetch(input.uri)).arrayBuffer();
    const safe = input.fileName.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-80) || 'file.pdf';
    const path = `files/${Date.now()}-${safe}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, body, { contentType: input.contentType, upsert: false });
    if (upErr) return { ok: false, message: upErr.message };
    const { data: session } = await supabase.auth.getSession();
    const row = {
      company: COMPANY,
      kind: 'file' as const,
      title: input.title.trim() || 'Brochure',
      file_path: path,
      sort: 0,
      updated_at: new Date().toISOString(),
      updated_by: session.session?.user.email ?? null,
    };
    const { error } = input.replace
      ? await supabase.from('sales_resources').update(row).eq('id', input.replace.id)
      : await supabase.from('sales_resources').insert(row);
    if (error) return { ok: false, message: error.message };
    if (input.replace?.filePath) await supabase.storage.from(BUCKET).remove([input.replace.filePath]);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Upload failed.' };
  }
}

/** A link to open a resource file, good for an hour. */
export async function resourceFileUrl(path: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
    return error || !data ? null : data.signedUrl;
  } catch {
    return null;
  }
}
