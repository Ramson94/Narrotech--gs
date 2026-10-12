import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",   // ← CRITICAL: send session cookie on every request
  });

  await throwIfResNotOk(res);
  return res;
}

// Start a field-analysis background job and poll until it finishes.
// The POST returns immediately with a jobId (202); we then poll the status
// endpoint every ~2.5s until it reports "done" or "error". Resolves with the
// exact same result shape the old synchronous /analyze endpoint returned
// ({ field, timeSeriesData, notificationSent }), so callers are unchanged.
export async function runAnalyzeJob(
  fieldId: number,
  body?: { dateFrom?: string; dateTo?: string },
  opts?: { intervalMs?: number; timeoutMs?: number },
): Promise<any> {
  const intervalMs = opts?.intervalMs ?? 2500;
  const timeoutMs = opts?.timeoutMs ?? 5 * 60 * 1000;

  const startRes = await apiRequest("POST", `/api/fields/${fieldId}/analyze`, body ?? {});
  const { jobId } = await startRes.json();
  if (!jobId) throw new Error("Failed to start analysis job");

  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() > deadline) throw new Error("Analysis timed out. Please try again.");
    await new Promise(r => setTimeout(r, intervalMs));
    const res = await apiRequest("GET", `/api/analyze-jobs/${jobId}`);
    const data = await res.json();
    if (data.status === "done") return data.result;
    if (data.status === "error") throw new Error(data.error || "Analysis failed");
    // status === "processing" → keep polling
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, { credentials: "include" });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
