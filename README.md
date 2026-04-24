# EarthMC Map Generation

Simple script taken from a test project with updated values for Nostra


## How to run

Clone the project

```bash
  git clone https://github.com/nomad-swe/earthmc-maprender
```

Go to the project directory

```bash
  cd earthmc-maprender
```

Install dependencies

```bash
  npm install
```

Run the script

```bash
  npm run start
  or
  node index.js
```


## Examples

```javascript
  // The different map methods which all contains some dafault values
  await generateNationMap();                 // Normal nation map
  await generateNationMap({ blank: true });  // Normal nation map (with overwritten default value)  
  await generateRangeMap();                  // Nation range map

  // calling the method with for example generateNationMap({ nationName: "Switzerland" })
  // will generate a nation map for Switzerland rather than France 
```