const layers4 = [
  { name:'L1', type:'copper', thicknessUm:35 }, { name:'PP1', type:'dielectric', thicknessMm:0.18, er:4.1 },
  { name:'L2', type:'copper', thicknessUm:35 }, { name:'CORE', type:'dielectric', thicknessMm:1.0, er:4.2 },
  { name:'L3', type:'copper', thicknessUm:35 }, { name:'PP2', type:'dielectric', thicknessMm:0.18, er:4.1 },
  { name:'L4', type:'copper', thicknessUm:35 },
];

export function highSpeedUsbFixture() {
  return {
    stackup:{ id:'JLC-4L-DEMO-2026-08', source:'fixture:fabricator-stackup-evidence', layers:layers4 },
    layout:{ board:{widthMm:45,heightMm:30}, gridMm:0.5, clearanceMm:0.5, components:[
      {ref:'J1',primitiveId:'pcb-j1',widthMm:9,heightMm:8,role:'edge-connector',fixed:true,xMm:5,yMm:15},
      {ref:'U1',primitiveId:'pcb-u1',widthMm:6,heightMm:6,near:['J1'],region:{xMin:12,yMin:10,xMax:24,yMax:20}},
    ]},
    highSpeed:[{ profileId:'usb2', net:'USB_D', pairGapMm:0.15, geometry:{widthMm:0.18,copperThicknessMm:0.035,heightMm:0.18,er:4.1}, segments:[
      {lengthMm:18.0,widthMm:0.18,neighborSpacingMm:0.6,referenceContinuous:true},
      {lengthMm:18.1,widthMm:0.18,neighborSpacingMm:0.6,referenceContinuous:true},
    ], routeGeometry:[{layer:1,startX:8,startY:14.8,endX:18,endY:14.8,lineWidth:0.18},{layer:1,startX:8,startY:15.2,endX:18,endY:15.2,lineWidth:0.18}] }],
    hdi:{layerCount:4,viaTypes:[{type:'through',fromLayer:1,toLayer:4,drillMm:0.3,diameterMm:0.6}]}, rf:[],
  };
}

export function hdiBgaFixture() {
  const input=highSpeedUsbFixture(); input.stackup={...input.stackup,id:'JLC-6L-HDI-DEMO-2026-08',layers:[...layers4.slice(0,3),{name:'PPX',type:'dielectric',thicknessMm:0.1,er:4.0},{name:'L5',type:'copper',thicknessUm:35},{name:'PPY',type:'dielectric',thicknessMm:0.1,er:4.0},{name:'L6',type:'copper',thicknessUm:35}]};
  input.highSpeed=[]; input.hdi={layerCount:6,maxStackedMicrovias:2,fabricatorEvidence:'fixture:JLC-HDI-capability-2026-08',laminationSteps:[{id:'press-1',layers:[1,2]},{id:'press-2',layers:[2,3,4,5,6]}],viaTypes:[
    {id:'mv12',type:'microvia',fromLayer:1,toLayer:2,drillMm:0.1,diameterMm:0.25},
    {id:'mv23',type:'microvia',fromLayer:2,toLayer:3,drillMm:0.1,diameterMm:0.25},
    {id:'th',type:'through',fromLayer:1,toLayer:6,drillMm:0.2,diameterMm:0.45},
  ],transitions:[{fromLayer:1,toLayer:3}],bga:[{rows:4,columns:4,pitchMm:0.8,padDiameterMm:0.35,minClearanceMm:0.15,availableLayers:3}],placedVias:[{net:'BGA_IO',x:20,y:15,holeDiameter:0.1,diameter:0.25,viaType:'microvia'}]}; return input;
}

export function rf24gFixture() {
  const input=highSpeedUsbFixture(); input.highSpeed=[]; input.rf=[{frequencyGHz:2.4,targetOhm:50,toleranceOhm:5,geometry:{widthMm:0.3,gapMm:0.05,heightMm:0.18,er:4.1},antennaKeepout:{verified:true,evidence:'fixture:antenna-drawing-rev-a'},viaFence:{lengthMm:20,pitchMm:1},simulationEvidence:{source:'fixture',solver:'openEMS',hash:'fixture-openems-result',note:'样板数据，不是求解器产出，不能当验收结论'},demo:true,simulationJob:{solver:'openEMS',geometryHash:'sha256:fixture-geometry',frequencySweepGHz:[0.1,2.4],ports:[{id:'P1',impedanceOhm:50}]}}]; return input;
}

export const engineeringFixtures={ 'HS-USB2-4L':highSpeedUsbFixture, 'HDI-BGA-6L':hdiBgaFixture, 'RF-24G-4L':rf24gFixture };
