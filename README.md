# Setup Scorer

Petit popup Windows, toujours au premier plan, qui donne un **score de 0 à 100** à un setup de trading
à partir de l'historique du journal Notion : structure 2, ligne de tendance, tendance de fond, direction,
unités de temps, paire, jour, heure…  Les champs sont facultatifs : le score bouge à chaque champ renseigné.

- Fond animé repris de l'application Tryst, thème sombre.
- `Ctrl+Alt+S` affiche ou masque la fenêtre, `Échap` la masque, l'icône de la zone de notification la rouvre.
- Sections dépliables : impact de chaque champ, setups suivis, fiabilité et données.
- Mises à jour automatiques depuis les versions GitHub (vérifiées au lancement puis toutes les 6 h).

## Données

Les données personnelles ne sont **pas** dans le dépôt ni dans l'installateur.
Au premier lancement, importer l'export Notion du journal (zip ou csv) : *Mettre à jour les données…*
Le journal importé reste dans le dossier utilisateur et survit aux mises à jour.

Règles de l'import : les lignes « Réel » sont les trades pris, les lignes « Backtest » sont les setups manqués ;
une ligne backtest qui répète un trade réel (même jour, paire, sens, structure) est retirée.

## Développement

```bash
npm install
npm start          # lance le popup
npm test           # vérifie l'import et le modèle (npm test chemin/export.zip pour tester sur un export)
npm run logo       # redessine build/icon.png et build/tray.png
npm run logo:file  # rogne et prépare l'icône depuis build/logo.png
npm run build:win  # installateur dans release/
```

## Publier une version

1. Monter `version` dans `package.json`.
2. `GH_TOKEN=<jeton avec accès au dépôt> npm run release` : construit l'installateur et le publie sur GitHub Releases
   avec `latest.yml`, que les applications installées lisent pour se mettre à jour.

## Fiabilité du score

Le modèle est une régression ridge du R de chaque trade sur les champs connus à l'entrée. Il est testé sur des setups
qu'il n'a pas vus (validation croisée) et l'interface affiche cette fiabilité ; en lecture « prudente », les effets sont
réduits à la part que la validation confirme.
