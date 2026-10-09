import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { rutaBloqueada } from "@/lib/rutas-de-better-auth";

const { POST: post, GET: get } = toNextJsHandler(auth);

/** Los endpoints de `organization` que cambian membresías sin avisar no existen para quien llama (ver `rutas-de-better-auth.ts`). */
const conFiltro = (siguiente: (req: Request) => Promise<Response>) => (req: Request) =>
    rutaBloqueada(req.method, new URL(req.url).pathname)
        ? Response.json({ error: "not_found" }, { status: 404 })
        : siguiente(req);

export const GET = conFiltro(get);
export const POST = conFiltro(post);
