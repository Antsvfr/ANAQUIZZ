/* Redirige l'import esm.sh des Edge Functions vers le remplaçant local, afin
   que le VRAI code des fonctions puisse s'exécuter sous Node. Rien d'autre
   n'est intercepté. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("https://esm.sh/@supabase/supabase-js")) {
    return { url: new URL("./supabase-shim.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
