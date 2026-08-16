# Diagnóstico de Anúncio Airbnb

Ferramenta online para analisar e melhorar anúncios Airbnb.

## Como usar online (Render)

1. Faz upload de todos os arquivos pro GitHub
2. No Render, conecta ao repositório e faz deploy
3. A ferramenta fica online 24/7 no link que o Render gera

## Como usar localmente

```bash
npm install
npm start
```

Depois vai em: http://localhost:3000

## O que funciona

- Busca automática de anúncios
- Análise de descrição por seções
- Cálculo de avaliações necessárias
- Sugestão de títulos com IA
- Análise de fotos com IA (Gemini)
- Diagnóstico do Selo Preferido dos Hóspedes

## Variáveis de ambiente

Cria um arquivo `.env` com:

```
GEMINI_API_KEY=sua-chave-aqui
```

Ou adiciona direto no Render > Environment Variables.
