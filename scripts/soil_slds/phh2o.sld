<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ogc="http://www.opengis.net/ogc" xmlns:gml="http://www.opengis.net/gml" xsi:schemaLocation="http://www.opengis.net/sld StyledLayerDescriptor.xsd" version="1.0.0">
  <NamedLayer>
    <Name>phh2o</Name>
    <UserStyle>
      <Title>phh2o</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
           <Geometry>
              <PropertyName>pH water (pH*10)</PropertyName>
              <Opacity>1</Opacity>
            </Geometry>
            <ColorMap type="intervals">
              <ColorMapEntry color="#FFFFFF" quantity="-32768" label="NODATA" opacity="0.7"/>
              <ColorMapEntry color="#f0f63d" label="0" quantity="0"/>
              <ColorMapEntry color="#f0f63d" label="34" quantity="34"/>
              <ColorMapEntry color="#f1ee2d" label="48" quantity="48"/>
              <ColorMapEntry color="#f1e51c" label="51" quantity="51"/>
              <ColorMapEntry color="#ebe51a" label="52" quantity="52"/>
              <ColorMapEntry color="#e0e41b" label="54" quantity="54"/>
              <ColorMapEntry color="#c0df28" label="55" quantity="55"/>
              <ColorMapEntry color="#a5db36" label="56" quantity="56"/>
              <ColorMapEntry color="#8dd645" label="57" quantity="57"/>
              <ColorMapEntry color="#86d44e" label="58" quantity="58"/>
              <ColorMapEntry color="#81d255" label="59" quantity="59"/>
              <ColorMapEntry color="#72c94c" label="60" quantity="60"/>
              <ColorMapEntry color="#62c042" label="61" quantity="61"/>
              <ColorMapEntry color="#54b93a" label="62" quantity="62"/>
              <ColorMapEntry color="#4bb736" label="64" quantity="64"/>
              <ColorMapEntry color="#42b532" label="65" quantity="65"/>
              <ColorMapEntry color="#39b32f" label="67" quantity="67"/>
              <ColorMapEntry color="#36ad31" label="68" quantity="68"/>
              <ColorMapEntry color="#35a536" label="70" quantity="70"/>
              <ColorMapEntry color="#359d3b" label="72" quantity="72"/>
              <ColorMapEntry color="#329a3d" label="73" quantity="73"/>
              <ColorMapEntry color="#2f993f" label="75" quantity="75"/>
              <ColorMapEntry color="#2c9840" label="76" quantity="76"/>
              <ColorMapEntry color="#2a9945" label="77" quantity="77"/>
              <ColorMapEntry color="#2fa45f" label="79" quantity="79"/>
              <ColorMapEntry color="#34b07a" label="79" quantity="79"/>
              <ColorMapEntry color="#36b993" label="80" quantity="80"/>
              <ColorMapEntry color="#30b6a4" label="81" quantity="81"/>
              <ColorMapEntry color="#28b6b5" label="82" quantity="82"/>
              <ColorMapEntry color="#1bc1c7" label="83" quantity="83"/>
              <ColorMapEntry color="#0fccd9" label="92" quantity="92"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
