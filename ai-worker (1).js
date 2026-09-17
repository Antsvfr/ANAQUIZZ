/* ============================================================
   ai-worker.js — Worker WebLLM (inférence locale, hors thread principal)
   ------------------------------------------------------------
   Ce fichier tourne dans un Web Worker séparé, chargé par index.html via :
     new Worker("ai-worker.js", { type: "module" })
   Il ne fait qu'une chose : brancher le moteur WebLLM (@mlc-ai/web-llm)
   sur les messages envoyés par le thread principal (via WebWorkerMLCEngine
   côté page). Tout le calcul GPU (WebGPU) et le téléchargement du modèle
   se font ici, pour ne jamais geler l'interface du site.

   Aucune clé API, aucun appel réseau vers un serveur à toi : les poids du
   modèle sont téléchargés directement depuis Hugging Face par le
   navigateur de l'utilisateur, puis mis en cache par le navigateur lui-même.
   ============================================================ */
import { WebWorkerMLCEngineHandler } from "https://esm.run/@mlc-ai/web-llm";

// Instancié immédiatement au chargement du script (recommandation officielle WebLLM) :
// l'écouteur de messages doit être prêt dès l'évaluation initiale du worker.
const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (msg) => {
  handler.onmessage(msg);
};
