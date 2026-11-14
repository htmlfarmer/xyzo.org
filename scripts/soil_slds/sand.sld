<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ogc="http://www.opengis.net/ogc" xmlns:gml="http://www.opengis.net/gml" xsi:schemaLocation="http://www.opengis.net/sld StyledLayerDescriptor.xsd" version="1.0.0">
  <NamedLayer>
    <Name>sand</Name>
    <UserStyle>
      <Title>sand</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Geometry>
              <PropertyName>Sand (g/kg)</PropertyName>
              <Opacity>1</Opacity>
            </Geometry>
            <ColorMap type="intervals">
              <ColorMapEntry color="#FFFFFF" quantity="-32768" label="NODATA" opacity="0.7"/>
               <ColorMapEntry color="#f2dac1" label="0" quantity="0"/>
               <ColorMapEntry color="#f2dac1" label="7" quantity="7"/>
              <ColorMapEntry color="#eed2b6" label="32" quantity="32"/>
              <ColorMapEntry color="#ebcbab" label="58" quantity="58"/>
              <ColorMapEntry color="#e7c4a0" label="83" quantity="83"/>
              <ColorMapEntry color="#e3bc96" label="109" quantity="109"/>
              <ColorMapEntry color="#e0b58b" label="134" quantity="134"/>
              <ColorMapEntry color="#dcae80" label="160" quantity="160"/>
              <ColorMapEntry color="#d8a775" label="185" quantity="185"/>
              <ColorMapEntry color="#d49f6b" label="211" quantity="211"/>
              <ColorMapEntry color="#d19860" label="236" quantity="236"/>
              <ColorMapEntry color="#cd9155" label="262" quantity="262"/>
              <ColorMapEntry color="#c98c50" label="288" quantity="288"/>
              <ColorMapEntry color="#c5894d" label="313" quantity="313"/>
              <ColorMapEntry color="#c1854a" label="339" quantity="339"/>
              <ColorMapEntry color="#bd8247" label="364" quantity="364"/>
              <ColorMapEntry color="#b97e44" label="390" quantity="390"/>
              <ColorMapEntry color="#b47b41" label="415" quantity="415"/>
              <ColorMapEntry color="#b0773e" label="441" quantity="441"/>
              <ColorMapEntry color="#ac743b" label="466" quantity="466"/>
              <ColorMapEntry color="#a87038" label="492" quantity="492"/>
              <ColorMapEntry color="#a36c35" label="517" quantity="517"/>
              <ColorMapEntry color="#9f6832" label="543" quantity="543"/>
              <ColorMapEntry color="#9b652f" label="569" quantity="569"/>
              <ColorMapEntry color="#97612c" label="594" quantity="594"/>
              <ColorMapEntry color="#935e29" label="620" quantity="620"/>
              <ColorMapEntry color="#8f5a26" label="645" quantity="645"/>
              <ColorMapEntry color="#8b5723" label="671" quantity="671"/>
              <ColorMapEntry color="#875320" label="696" quantity="696"/>
              <ColorMapEntry color="#83501d" label="722" quantity="722"/>
              <ColorMapEntry color="#7e4c1a" label="747" quantity="747"/>
              <ColorMapEntry color="#7a4917" label="773" quantity="773"/>
              <ColorMapEntry color="#764615" label="799" quantity="799"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
