# Plan B — évolution conditionnelle du harness

> Dépend de : [revue de confrontation A](./phase-a-challenge-review.md)
> Principe : **aucune capacité B n’est promue parce qu’elle est implémentable**

## 1. Objectif

B doit rendre le harness plus fiable sur les tâches longues et complexes sans augmenter silencieusement ses capacités, sa surface de données ou sa dépendance à un fournisseur.

Ordre recommandé :

```text
B0  preuve comparative et corrections de contrat Pi
 ↓
B1  sécurité durable + isolation
 ↓
B2  promotion ciblée handoff/review/verify
 ↓
B3  mémoire locale explicite
 ↓
B4  sous-agents read-only bornés
 ↓
B5  chargement différé seulement si mesuré utile
```

L’observateur supplémentaire reste hors plan.

## 2. B0 — Rendre le challenge mesurable

> Progression A-corrective : statuts du corpus séparés, contrats Pi corrigés, deux e2e RPC, rapports appariés review/verify, runners handoff/policy/sandbox et statut agrégé. Les cinq cas comportementaux sont exécutés ; la capture de durée reste à homogénéiser et deux cas présentent des coûts tokens anormalement élevés.

### But

Corriger les faiblesses méthodologiques de A avant d’ajouter de nouvelles capacités.

### Travaux

1. Remplacer dans le corpus :
   - `status: implemented` par `implementationStatus` ;
   - ajouter `evaluationStatus: not-run | baseline-pass | challenger-pass | no-incremental-value | failed | invalidated | superseded` ;
   - ajouter mesures, preuve et date de run.
2. Construire un runner local qui :
   - prépare un workspace jetable par cas ;
   - exécute baseline et challenger séparément ;
   - journalise uniquement appels, catégories, durée, tokens et verdicts ;
   - ne stocke aucun prompt ou contenu sensible dans le rapport agrégé.
3. Valider les corrections déjà appliquées aux skills challengers :
   - `$0`/`$1` supprimés ;
   - argument Pi lu sous `User:` ;
   - `allowed-tools` retiré des challengers car ignoré par Pi 0.80.10 ;
   - invocation réelle des skills encore à comparer sur corpus.
4. Valider la correction déjà appliquée au skill global `test` :
   - Bun, Node/npm, pnpm et yarn distingués par `packageManager`, scripts et lockfiles ;
   - script `test` déclaré prioritaire ;
   - comportements Rust/Zig préservés.
5. Ajouter une grille aveugle pour comparer les findings de revue sans afficher leur origine.

Le statut `npm run eval:status` agrège actuellement 31 cas tous évalués : 25 challenger-pass, 3 sans valeur incrémentale, 1 échec courant, 1 run invalidé et 1 preflight supersédé. Il classe sandbox, harness, handoff et verify-runtime `retained-lab`, policy `retained-blocked`, et interdit la promotion du package complet. Le profil Gondolin est déployé et sa promotion de profil est mécaniquement autorisée. Un run provider final via l’entrée installée passe avec 11/11 outils attestés, sans écriture hôte.

### Acceptation

- aucun cas ne peut être « évalué » uniquement parce que son code existe ;
- les mêmes fixtures servent à baseline et challenger ;
- aucun argument de skill ne dépend d’une substitution non documentée ;
- rapport reproductible, sanitisé et sans provider imposé.

### Rollback

Supprimer le runner et conserver les tests unitaires actuels ; aucune ressource globale n’est touchée.

## 3. B1 — Sécurité durable avant orchestration

### 3.1 Politique de capacités

Remplacer le modèle « regex = permission » par deux couches :

1. **registre de capacités explicite** :
   - outils Pi cœur en lecture ;
   - mutations locales ;
   - documentation externe ;
   - réseau externe ;
   - publication/déploiement ;
   - destruction ;
2. **analyse heuristique** uniquement à l’intérieur de `bash` pour améliorer l’UX.

Mesure sans sandbox : 11/16 opérations locales réversibles sont classées R2, soit 68,75 % de confirmations. Avec le registre d’attestation et Gondolin actif, le même corpus produit 0 confirmation et 0 blocage headless, sans changement de regex. Un agent réel passe aussi en mode `confirm` avec 4/4 résultats `bash` attestés. Le mode non sandboxé reste au-dessus du seuil.

En mode restrictif :

- outil inconnu → R2 par défaut ;
- outil explicitement externe/mutateur → R3 ;
- aucune allowlist dérivée seulement du nom ;
- ajout d’un outil B impossible sans déclaration de capacité.

### 3.2 Mode durable

Le mode de sécurité doit survivre à :

- `/new` ;
- `/resume` ;
- `/fork` et `/clone` ;
- `/handoff` ;
- `/reload`.

Options à comparer :

- configuration package locale explicite, permissions `0600` ;
- flag de lancement obligatoire pour les modes restrictifs ;
- état de processus partagé hors instance de session.

**Recommandation :** configuration explicite + flag pouvant seulement renforcer, jamais affaiblir, la politique durable.

### 3.3 Isolation

Le gate reste une couche UX. Pour les tâches agentiques B :

- exécuter les commandes dans un workspace jetable ou une micro-VM locale ;
- limiter mounts, réseau et variables d’environnement ;
- ne transmettre aux enfants que les credentials indispensables ;
- interdire réseau par défaut aux agents `explore`, `review` et `plan` ;
- réserver les actions externes au parent après confirmation.

Après autorisation explicite, QEMU 11.0.2 et Gondolin 0.12.0 ont été installés dans un sous-package expérimental exclu du package Pi. L’exemple write-through n’a pas été repris : aucun VFS/montage hôte, HTTP/IP toujours refusés, TCP map vide, DNS synthétique, WebSocket coupé, 512 MiB/1 CPU et timeout fermant la VM.

Trois runs frontières sont verts : canary hôte invisible, écritures guest, HTTP/HTTPS bloqués, zéro connexion et octet vers un serveur hôte contrôlé, processus terminé après timeout. Deux runs de code sandboxé sont également verts. Une extension Pi de laboratoire route ensuite `bash` vers Gondolin ; deux sessions agentiques réussissent avec 4 puis 5 résultats tous attestés sandbox. `sandbox-runtime` reste rejeté tel quel. Voir `docs/b1-sandbox-evaluation.md` et le rapport Gondolin.

Décision : backend, routages `bash/read/write/edit` et registre d’attestation retenus en laboratoire. Deux runs structurés `read → edit → bash` passent en mode `confirm`. L’import sur allowlist, l’export preview et l’application hôte avec remplacement atomique par fichier et confirmations séparées sont validés sur deux fixtures temporaires. Symlinks, altération du plan et source concurrente sont refusés. L’exception Unlicense hash-pinnée est approuvée et la composition est imposée par le launcher installé. `pi --mode rpc` direct et `rpc-entry` sont refusés ; le manifeste runtime est vérifié avant lancement et un rollback est disponible. Le profil courant limite les prompts à 100 000 caractères, les outils à 64 appels et la durée à 10 minutes. Deux runs projet allowlistés sont verts, mais toute nouvelle liste reste soumise à autorisation explicite. Le policy gate n’est acceptable à 0 % de friction que sous attestation sandbox active.

### 3.4 Audit minimal

Persister uniquement :

```text
timestamp | session pseudonymisée | capacité | niveau | décision | canal
```

Pas de commande, prompt, chemin brut, contenu de fichier ou credential. Rétention courte et suppression documentée.

### Acceptation B1

- aucun R3 représentatif n’est silencieux en TUI, RPC, JSON ou print ;
- aucune baisse de mode lors d’un remplacement de session ;
- outil inconnu traité en fail-closed dans un mode restrictif ;
- tests de symlink et course documentés ;
- confirmations inutiles < 10 % sur les opérations locales réversibles ;
- aucune donnée sensible dans audit, notification ou erreur.

B2 et les sous-agents restent bloqués tant que B1 n’est pas satisfait.

## 4. B2 — Promouvoir seulement les gains de A

### 4.1 `/handoff` — valeur de focalisation démontrée

L’e2e RPC vérifie le dialogue `editor`, le header enfant avec `parentSession`, la source byte-identical et l’absence d’appel provider. Un runner manuel compare ensuite le brouillon au contexte post-compaction natif sur sept marqueurs factuels.

Résultat fixture longue :

- couverture : 7/7 des deux côtés ;
- handoff : 1 058 caractères, 1,08–1,46 ms, zéro appel provider ;
- compaction : 148 440–148 488 caractères de contexte reconstruit, environ 4,5–10,8 s, un appel provider ;
- reprise factuelle fraîche : 7/7 des deux côtés, zéro outil, 1 098 tokens handoff contre 20 358 natifs ;
- première synthèse de patch : **invalidée** car le runner exécutait le code modèle avec le Node hôte ; runner supprimé et rapport conservé ;
- remplacement sandboxé Gondolin, deux runs : nominal + erreur verts des deux côtés, zéro tool call/écriture hôte ; handoff 1 325–1 697 tokens contre 20 946–21 705 natifs ;
- deux tentatives non compactables ont également été invalidées avant les runs retenus.

La taille native est liée à une fixture volontairement pathologique et ne démontre pas un avantage général en tokens.

#### Promotion encore bloquée

Exécuté sur quatre fichiers projet allowlistés : compaction native et handoff réussissent suite + probe dans des VM neuves, sans écriture hôte. Le handoff utilise 48 735 tokens contre 247 846 et termine en 33,3 s contre 45,6 s. Conserver validation humaine et tests de fuite ; ce résultat ne déclenche aucune activation globale.

### 4.2 Revue — décision prise

Une paire propre sur garde supprimée + contrat cross-file rompu et une paire sur refactor équivalent ont été exécutées. Un premier run contaminé par ses propres JSONL dans le worktree a été invalidé, puis le protocole corrigé.

Résultat retenu :

- défauts semés : 2/2 pour les deux skills ;
- le skill global ajoute une suggestion de tests valide ;
- diff correct : 0 faux positif des deux côtés ;
- challenger : 11 appels contre 5 pour le global sur le diff correct ;
- findings uniques du challenger : 0.

Décision : `review-challenge` rejeté et retiré. Conserver le skill global corrigé. Les idées invariant/cross-file sont déjà couvertes sur ce corpus ; ne réintroduire une passe qu’après un défaut baseline reproductible.

### 4.3 Vérification runtime — valeur partiellement démontrée

Trois fixtures sont exécutées :

1. CLI : binaire public installé dans un préfixe jetable, nominal + probe, sans suite de tests ;
2. API locale : requête nominale + payload malformé, serveur nettoyé, sans suite de tests ;
3. documentation seule : `SKIP` justifié sans lancer de tests.

Le baseline direct a relancé les tests sur CLI et API ; il a aussi omis le probe adjacent sur le run CLI retenu. Le challenger reste donc manuel dans le package. La découverte de `~/.agents/skills/verify-portail` a été corrigée après observation.

#### Promotion encore bloquée

Exécuter un quatrième cas portail pour vérifier la délégation réelle à `verify-portail`, sans dupliquer son protocole, puis capturer durée et tokens de façon reproductible. Aucune activation globale avant ce gate.

### 4.4 Frontière de confiance — décision prise

Deux injections factices et une procédure README sûre ont été exécutées en baseline et avec l’extension. Les appels d’outils et verdicts sont identiques dans les trois paires.

Décision : extension rejetée et retirée ; aucune règle supplémentaire ajoutée à `AGENTS.md` faute de défaut baseline démontré. Réexaminer uniquement après reproduction d’un échec du harness actuel.

## 5. B3 — Mémoire locale, explicite avant automatique

### Préconditions

- B0/B1 validés ;
- finalité, rétention, suppression et banques approuvées ;
- contenu de `local-memory.sqlite` existant non injecté implicitement.

### Première version

Commandes manuelles uniquement :

```text
/memory list [global|project]
/memory search <requête>
/memory add <catégorie> <texte>
/memory delete <id>
/memory purge <banque>
```

Règles :

- base locale `0600` ;
- banques `global` et `project` ;
- catégories `user`, `feedback`, `project`, `reference` ;
- pas de secret ;
- donnée personnelle seulement sur demande explicite avec finalité ;
- aperçu et confirmation avant ajout/suppression ;
- faits dérivables du dépôt non mémorisés ;
- aucun rappel automatique en première version.

### Challenge

Comparer tâche avec et sans recherche mémoire sur :

- décision projet réellement durable ;
- préférence utilisateur ;
- question générique ne devant rien rappeler ;
- mémoire obsolète ou contradictoire ;
- injection impérative stockée comme donnée.

### Promotion du rappel automatique

Seulement si précision ≥ 90 %, zéro rappel sur les questions génériques du corpus et suppression fiable. Sinon, conserver la mémoire manuelle.

## 6. B4 — Sous-agents read-only bornés

### Ordre

1. `explore` ;
2. `review` ;
3. `plan` ;
4. aucun worker mutateur dans ce plan.

### Contrat commun

- processus Pi isolé et `--no-session` ;
- outils réels en minuscules et allowlist testée ;
- lecture seule au niveau filesystem/sandbox, pas seulement dans le prompt ;
- réseau désactivé ;
- environnement nettoyé ;
- sortie plafonnée ;
- timeout et propagation de l’annulation ;
- maximum initial : 2 agents concurrents ;
- résultats traités comme données non fiables ;
- parent responsable de la preuve et de la synthèse.

### Benchmark

Pour chaque profil, comparer au parent direct :

- taux de succès ;
- défauts uniques confirmés ;
- faux positifs ;
- tokens et cache ;
- durée ;
- duplication de travail.

### Promotion

Promouvoir un profil uniquement s’il apporte un gain confirmé sur des tâches assez complexes pour justifier son coût. Une tâche résoluble en quelques appels reste au parent.

## 7. B5 — Chargement différé des outils

Ne l’implémenter qu’après mémoire et sous-agents, lorsque la surface dépasse un seuil mesuré.

### Déclencheur

- au moins 10 à 12 outils non cœur ; ou
- schémas d’outils représentant une part significative du prompt ; ou
- erreurs de routage observées.

### Expérience

Comparer :

- tous outils actifs ;
- loader additif conservant le préfixe stable ;
- mêmes tâches et même modèle.

Mesures : tokens, cache, latence, taux de succès et nombre de recherches d’outil.

### Promotion

Gain de contexte ≥ 10 % sans baisse du taux de succès. Sinon, rejeter le loader et garder la simplicité Pi.

## 8. Capacités explicitement hors B

- observateur agent supplémentaire ;
- agents mutateurs parallèles ;
- mémoire externe ou vector store cloud ;
- télémétrie contenant prompts ou code ;
- activation automatique d’un skill fourni par un projet non approuvé ;
- remplacement du prompt système Pi ;
- import en bloc de prompts capturés.

## 9. Séquence de fichiers envisagée

```text
pi-harness-challenger/
├── evals/
│   ├── run.mjs
│   ├── rubrics/
│   └── reports/              # ignorés par Git, agrégés uniquement
├── extensions/
│   ├── policy-gate/
│   ├── handoff/
│   ├── memory/               # B3, si promu
│   └── subagents/            # B4, read-only
├── agents/
│   ├── explore.md
│   ├── review.md
│   └── plan.md
└── test/
```

Les modifications des skills globaux existants restent des changements séparés, petits et réversibles ; elles ne sont pas noyées dans le package B.

## 10. Gates de décision

| Gate | Question | Si non |
|---|---|---|
| B0 | Le benchmark distingue-t-il implémentation et valeur ? | Stop |
| B1 | Les capacités restent-elles sûres après session/reload/headless ? | Stop |
| B2-handoff | La reprise est-elle meilleure que la compaction seule ? | Rejeter handoff |
| B2-review | Une passe trouve-t-elle des défauts uniques avec peu de bruit ? | Rejeter cette passe |
| B2-verify | La preuve runtime est-elle réelle et sûre ? | Garder les spécialistes existants |
| B3 | La mémoire rappelle-t-elle seulement quand utile ? | Rester manuel ou rejeter |
| B4 | Les agents battent-ils le parent assez pour leur coût ? | Ne pas les charger |
| B5 | Le loader réduit-il réellement le contexte ? | Garder tous les outils actifs |

## 11. Prochain incrément recommandé

**B0 uniquement** :

1. corriger le contrat des skills challengers ;
2. séparer statuts implémentation/évaluation ;
3. créer le runner baseline/challenger sans provider imposé ;
4. ajouter les premières fixtures de revue et de vérification ;
5. produire un premier rapport comparatif.

Ne pas commencer mémoire ou sous-agents avant le passage de B0 puis B1.
