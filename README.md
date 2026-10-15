# EditorVideo

Editor de vídeo local para Windows, feito para Reels/TikTok/Shorts. Roda 100% offline num `.exe` portátil.

## Recursos

- **Legenda automática com 1 clique**: transcrição local (whisper.cpp, GPU NVIDIA ou CPU), legendas em faixa própria, blocos editáveis, exporta `.srt`.
- **Modelos de legenda personalizáveis**: fonte, cor, contorno, sombra, caixa de fundo (bloco/linha/palavra), destaque karaokê, animação de entrada (pop, pulo, fade, subir). O padrão "Reels Padrão" segue o `REGRAS-DE-EDICAO.md`.
- **Glossário de correções**: ex.: "cloud" → "Claude".
- **Corte manual**: dividir no cursor (S), aparar arrastando as bordas, mover entre faixas, ímã, desfazer/refazer.
- **Corte automático de silêncio**: remove pausas > 0,3 s deixando 0,15 s de respiro, com prévia em vermelho na timeline antes de aplicar e zoom alternado opcional nos cortes.
- **Área segura** de Reels, TikTok e Shorts, com encaixe magnético ao arrastar.
- **Tela dividida automática**: 2 vídeos empilhados (em cima/embaixo), divisão ajustável.
- **Faixas ilimitadas** de qualquer tipo (vídeo, imagem, texto, legenda, áudio), com camadas e **keyframes** de posição, escala, rotação e opacidade.
- **Áudio**: música de fundo, volume por clipe, fade in/out.
- **Exportação** MP4 H.264 em 1080x1920 (9:16) ou 1920x1080 (16:9). O que aparece no preview é o que sai no arquivo.

## Usar

Abra `EditorVideo.exe`. Os dados (cache de mídia, modelos de transcrição, configurações) ficam na pasta
`EditorVideo-dados`, ao lado do executável. Na primeira legenda o programa oferece baixar o motor de transcrição
(~10 MB na CPU, +690 MB para a GPU NVIDIA) e o modelo (~550 MB o preciso ou ~190 MB o rápido).

Atalhos: Espaço (play), S (dividir), Del (excluir), Shift+Del (excluir e fechar buraco), Ctrl+Z/Y,
Ctrl+C/V, ←/→ (frame), Ctrl+roda (zoom da timeline), Alt ao arrastar (sem ímã).

## Desenvolvimento

Requisitos: Node 22+, Windows.

```bash
npm install
npm run fetch-binaries   # copia/baixa ffmpeg e ffprobe para resources/bin
npm run dev              # abre o app em modo desenvolvimento
npm test                 # testes (vitest)
npm run typecheck
npm run dist             # gera a pasta portátil release/win-unpacked (EditorVideo.exe)
```

Se o terminal tiver `ELECTRON_RUN_AS_NODE` definido (acontece dentro do VS Code), rode
`set ELECTRON_RUN_AS_NODE=` antes de `npm run dev`.

## Arquitetura

| Parte | Tecnologia |
|---|---|
| App | Electron + electron-vite, React 19, Tailwind 4, Zustand + Immer |
| Preview e export | Compositor próprio em Canvas 2D (mesmo código nos dois) |
| Decodificação no export | WebCodecs `VideoDecoder` + parser MP4 próprio (`src/renderer/engine/mp4.ts`) |
| Codificação | WebCodecs `VideoEncoder` (H.264 por hardware) + mp4-muxer; FFmpeg mixa o áudio e junta |
| Importação | FFmpeg converte para um proxy H.264 CFR (HDR → SDR, rotação, máx. 1920 px) |
| Transcrição | whisper.cpp (`whisper-cli.exe`) baixado no primeiro uso; tempos por palavra |

Pastas principais:

- `src/main/` processo Node: importação, FFmpeg, whisper, export, protocolo `media://`
- `src/renderer/engine/` compositor, reprodução, export, texto/legenda, keyframes
- `src/renderer/features/` legenda (agrupamento/glossário/SRT), corte automático, tela dividida e área segura
- `src/renderer/state/` modelo do projeto, comandos de edição, desfazer/refazer
- `src/renderer/ui/` interface
