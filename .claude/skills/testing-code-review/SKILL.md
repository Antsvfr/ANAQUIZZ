---
name: testing-code-review
description: Procédure de validation après une modification. À consulter avant de considérer une tâche terminée, et avant tout commit/push.
---

# Testing & Code Review

## Contexte : pas de suite de tests automatisée dans le dépôt

Ce projet n'a ni framework de test ni CI configurée dans le dépôt
lui-même. La validation d'une modification repose donc entièrement sur
une vérification manuelle rigoureuse — pas de filet de sécurité
automatique en cas d'oubli.

## Procédure après une modification significative

1. **Vérifier la syntaxe.** Pour `index.html` : extraire le dernier bloc
   `<script>` (celui du script principal) et le valider avec
   `node --check` — c'est la manière la plus rapide de détecter une
   erreur de syntaxe dans un fichier de cette taille avant même d'ouvrir
   un navigateur. Pour les modules séparés (`auth.js`, `translations.js`,
   `smart-revision.js`, `statistics.js`) : `node --check <fichier>`
   directement.
2. **Vérifier les erreurs / la console.** Servir le projet localement
   (`python3 -m http.server <port>` depuis la racine — site statique,
   aucune étape de build) et charger la page dans un navigateur piloté
   (Playwright), en écoutant les événements `console`/`pageerror`. Filtrer
   les échecs réseau attendus dans un environnement sans accès Internet
   (CDN bloqué) plutôt que de les traiter comme de vraies régressions.
3. **Tester le comportement réel**, pas supposé : appeler les vraies
   fonctions de production dans la page (`trackQuizAnswer`, `startQuiz`,
   `saveProgress`, etc.) plutôt que de réimplémenter une simulation de la
   logique dans le script de test.
4. **Tester le responsive** : au moins petit mobile (~375px), grand
   mobile (~390–430px), tablette (~800px), desktop (≥1280px) — voir
   `i18n-accessibility-responsive`.
5. **Tester les erreurs / états limites** : pool vide, fichier mal
   formé, IA indisponible, réseau indisponible.
6. **Tester les états vides** : premier usage sans aucune donnée — jamais
   un "0" partout, voir `premium-ui`.
7. **Tester les données** : avec peu de données, avec beaucoup (historique
   synthétique volumineux pour la performance), avec d'anciennes données
   ne comportant pas les nouveaux champs (compatibilité ascendante).
8. **Vérifier les régressions** : rebalayer les autres onglets/
   fonctionnalités voisines après une modification, pas seulement celle
   qui vient d'être touchée.
9. **Vérifier les traductions** : les 5 langues, en particulier chercher
   une clé brute affichée (`namespace.cle` visible à l'écran = oubli) et
   tester l'allemand pour les débordements de texte.
10. **Vérifier les performances** quand pertinent : mesurer
    (`performance.now()`) plutôt que de supposer, surtout pour tout
    calcul qui touche un historique potentiellement long.

## Compte A / Compte B — test obligatoire pour toute donnée liée à l'utilisateur

Pour toute fonctionnalité qui affiche une donnée par compte, tester
explicitement : Compte A produit une vraie activité → déconnexion →
Compte B (jamais connecté) → vérifier qu'aucune donnée de A n'apparaît
chez B. Voir `supabase-auth-data` pour le mécanisme de cloisonnement à
respecter et le piège déjà rencontré (état en mémoire non réinitialisé).
Dans ce bac à sable, ce test se fait en forçant directement
`LyonAuth.available`/`LyonAuth.state` (le réseau Supabase réel n'étant
pas joignable) — un test ainsi mené doit être signalé comme **simulé**,
pas comme une validation contre un vrai réseau Supabase.

## Règle absolue sur l'honnêteté des rapports de test

**Ne jamais prétendre avoir effectué un test qui n'a pas réellement été
effectué.** Distinguer explicitement, dans tout rapport :
- ce qui a été testé **réellement** (navigateur piloté, vraies fonctions
  de production) ;
- ce qui a été **simulé** (ex. compte Supabase forcé sans réseau réel) ;
- ce qui n'a **pas pu être testé** du tout (ex. réseau Supabase réel,
  génération WebLLM réelle si WebGPU n'est pas disponible dans
  l'environnement de test) — le dire explicitement plutôt que
  l'omettre.

## Quand un échec de test apparaît

Avant de corriger : déterminer si l'échec vient d'un **vrai bug produit**
ou d'une **erreur dans le script de test** (hypothèse de données
incorrecte, sélecteur ambigu, timing). Les deux sont arrivés dans ce
projet — corriger la bonne chose, et dire clairement laquelle des deux
c'était dans le rapport final.
